/**
 * Realtime client layer.
 *
 * Opens a WebSocket to /api/v1/ws?access_token=<JWT>. The server sends
 * { type: 'ready' } once authenticated, then JSON frames of shape
 * { topic, type, payload, at }. We:
 *   - auto-reconnect with exponential backoff (capped),
 *   - send periodic { type: 'ping' } and expect { type: 'pong' },
 *   - expose connection status, the latest events, and a subscribe() callback,
 *   - invalidate the relevant react-query caches per topic so lists live-refresh,
 *   - feed notification/error frames into a bell buffer.
 *
 * SALES principals only receive lead + notification topics (enforced server
 * side); ADMIN receives all.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAccessToken } from '../lib/storage';
import { wsUrl } from '../lib/config';
import { useAuth } from '../auth/AuthContext';
import type { RealtimeEvent, RealtimeTopic } from '../lib/types';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface NotificationItem {
  id: string;
  topic: RealtimeTopic;
  type: string;
  message: string;
  at: string;
  read: boolean;
}

type EventListener = (event: RealtimeEvent) => void;

interface RealtimeContextValue {
  status: ConnectionStatus;
  lastEvent: RealtimeEvent | null;
  notifications: NotificationItem[];
  unreadCount: number;
  subscribe: (listener: EventListener) => () => void;
  markAllRead: () => void;
  clearNotifications: () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | undefined>(undefined);

const MAX_NOTIFICATIONS = 50;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

/** Map a realtime topic to the react-query keys that should be invalidated. */
const TOPIC_QUERY_KEYS: Record<RealtimeTopic, string[][]> = {
  lead: [['leads'], ['leadStats'], ['dashboard']],
  draft: [['drafts'], ['dashboard']],
  scheduled_post: [['calendar'], ['dashboard']],
  insight: [['insights'], ['dashboard']],
  token_alert: [['platformTokens']],
  workflow: [['workflow']],
  notification: [['dashboard'], ['notifications']],
};

function describeEvent(event: RealtimeEvent): string {
  const payload = event.payload as Record<string, unknown> | null;
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string') return payload.message;
  }
  return `${event.topic}: ${event.type}`;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<ConnectionStatus>('closed');
  const [lastEvent, setLastEvent] = useState<RealtimeEvent | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const listenersRef = useRef<Set<EventListener>>(new Set());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const closedByUserRef = useRef(false);

  const subscribe = useCallback((listener: EventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const handleEvent = useCallback(
    (event: RealtimeEvent) => {
      setLastEvent(event);

      // Invalidate relevant query caches so lists live-refresh.
      const keys = TOPIC_QUERY_KEYS[event.topic];
      if (keys) {
        for (const key of keys) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }

      // Feed the notification bell for notification/lead/insight/token frames.
      if (
        event.topic === 'notification' ||
        event.topic === 'token_alert' ||
        event.topic === 'insight' ||
        event.topic === 'lead'
      ) {
        const item: NotificationItem = {
          id: `${event.topic}-${event.at}-${Math.random().toString(36).slice(2, 8)}`,
          topic: event.topic,
          type: event.type,
          message: describeEvent(event),
          at: event.at,
          read: false,
        };
        setNotifications((prev) => [item, ...prev].slice(0, MAX_NOTIFICATIONS));
      }

      // Fan out to manual subscribers.
      for (const listener of listenersRef.current) {
        listener(event);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (!isAuthenticated) {
      // Tear down any existing connection when logged out.
      closedByUserRef.current = true;
      if (socketRef.current) socketRef.current.close();
      socketRef.current = null;
      setStatus('closed');
      return;
    }

    closedByUserRef.current = false;

    const clearTimers = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (closedByUserRef.current) return;
      const attempt = reconnectAttemptsRef.current;
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      reconnectAttemptsRef.current = attempt + 1;
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    function connect() {
      const token = getAccessToken();
      if (!token) {
        scheduleReconnect();
        return;
      }

      setStatus('connecting');
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl('/api/v1/ws', token));
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setStatus('open');
        // Heartbeat to keep the connection alive through proxies.
        if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL_MS);
      };

      socket.onmessage = (raw: MessageEvent) => {
        let data: unknown;
        try {
          data = JSON.parse(typeof raw.data === 'string' ? raw.data : '');
        } catch {
          return;
        }
        if (!data || typeof data !== 'object') return;
        const frame = data as { type?: string; topic?: string; payload?: unknown; at?: string };

        // Control frames.
        if (frame.type === 'pong' || frame.type === 'ready') return;
        if (frame.type === 'error') {
          // Server rejected auth (e.g. expired token). Close and let backoff retry;
          // the apiClient refresh path will mint a new token on the next request.
          return;
        }

        // Domain event frame.
        if (frame.topic && typeof frame.topic === 'string') {
          handleEvent({
            topic: frame.topic as RealtimeTopic,
            type: frame.type ?? 'event',
            payload: frame.payload ?? null,
            at: frame.at ?? new Date().toISOString(),
          });
        }
      };

      socket.onerror = () => {
        // onclose will follow; reconnection handled there.
      };

      socket.onclose = () => {
        setStatus('closed');
        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (!closedByUserRef.current) scheduleReconnect();
      };
    }

    connect();

    return () => {
      closedByUserRef.current = true;
      clearTimers();
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close();
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, handleEvent]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const value = useMemo<RealtimeContextValue>(
    () => ({
      status,
      lastEvent,
      notifications,
      unreadCount,
      subscribe,
      markAllRead,
      clearNotifications,
    }),
    [status, lastEvent, notifications, unreadCount, subscribe, markAllRead, clearNotifications],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error('useRealtime must be used within a RealtimeProvider');
  }
  return ctx;
}
