/**
 * Notifications bell — backed by PERSISTED notifications (server is authoritative
 * for read-state), with the realtime stream kept as the live signal.
 *
 * - On mount: fetches the unread count (badge). On open: fetches the recent
 *   notification list and marks unread items read (optimistic) — Req 8.6, 9.1,
 *   9.2, 9.4.
 * - The badge prefers the server unread-count but merges a live "bump" so a
 *   realtime `notification` frame nudges the badge immediately, then settles
 *   back to the server value once the invalidated query refetches.
 * - Clicking a notification marks just that one read (optimistic) and re-fetches
 *   the unread count.
 *
 * The realtime layer (RealtimeContext) already invalidates the ['notifications']
 * query keys on a `notification` frame; we additionally subscribe here so the
 * bell self-bumps without waiting for a refetch.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRealtime } from '../realtime/RealtimeContext';
import {
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from '../api/notifications';
import type { NotificationListResult } from '../api/notifications';
import { Empty, ErrorMessage, Loading, formatDate } from './ui';
import { Icon } from './Icon';

const LIST_KEY = ['notifications', 'list'] as const;
const UNREAD_KEY = ['notifications', 'unread-count'] as const;
const PANEL_LIMIT = 20;

export function NotificationsBell() {
  const queryClient = useQueryClient();
  const { subscribe, markAllRead: markRealtimeRead } = useRealtime();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Server unread count (badge). Always enabled so the badge shows on mount.
  const unreadQuery = useQuery({
    queryKey: UNREAD_KEY,
    queryFn: () => getUnreadCount(),
  });

  // Recent persisted notifications — lazily fetched when the panel opens.
  const listQuery = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => listNotifications(1, PANEL_LIMIT),
    enabled: open,
  });

  // Live "bump": a realtime notification frame increments this immediately so
  // the badge reacts without waiting for the invalidated query to refetch. It
  // resets to 0 whenever a fresh server unread-count lands.
  const [liveBumps, setLiveBumps] = useState(0);

  useEffect(() => {
    if (unreadQuery.isSuccess) setLiveBumps(0);
  }, [unreadQuery.dataUpdatedAt, unreadQuery.isSuccess]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.topic === 'notification') {
        setLiveBumps((n) => n + 1);
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      }
    });
  }, [subscribe, queryClient]);

  // Close the panel on an outside click.
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Optimistic, idempotent mark-as-read for a single notification (Req 9.2).
  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const prevList = queryClient.getQueryData<NotificationListResult>(LIST_KEY);
      const prevUnread = queryClient.getQueryData<{ count: number }>(UNREAD_KEY);

      const wasUnread = prevList?.items.some((n) => n.id === id && !n.read) ?? false;

      if (prevList) {
        queryClient.setQueryData<NotificationListResult>(LIST_KEY, {
          ...prevList,
          items: prevList.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
        });
      }
      if (prevUnread && wasUnread) {
        queryClient.setQueryData<{ count: number }>(UNREAD_KEY, {
          count: Math.max(0, prevUnread.count - 1),
        });
      }
      return { prevList, prevUnread };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prevList) queryClient.setQueryData(LIST_KEY, ctx.prevList);
      if (ctx?.prevUnread) queryClient.setQueryData(UNREAD_KEY, ctx.prevUnread);
    },
    onSettled: () => {
      // Re-fetch the authoritative unread count after the write settles.
      void queryClient.invalidateQueries({ queryKey: UNREAD_KEY });
    },
  });

  // When the panel opens with loaded data, mark any unread items read so the
  // persisted read-state reflects that ADMIN has seen them (Req 9.2). Self-
  // stabilizing: the optimistic update clears the unread set on the next pass.
  useEffect(() => {
    if (!open) return;
    const items = listQuery.data?.items;
    if (!items) return;
    for (const n of items) {
      if (!n.read) markReadMutation.mutate(n.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listQuery.data]);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Clear the realtime session buffer so its contribution doesn't linger.
    if (next) markRealtimeRead();
  }

  const items = listQuery.data?.items ?? [];
  const serverUnread = unreadQuery.data?.count ?? 0;
  const badge = serverUnread + liveBumps;
  const hasUnread = items.some((n) => !n.read);

  function markAll() {
    for (const n of items) {
      if (!n.read) markReadMutation.mutate(n.id);
    }
  }

  return (
    <div className="bell" ref={ref}>
      <button className="bell-btn" onClick={toggle} aria-label="Thông báo" title="Thông báo">
        <Icon name="bell" size={18} />
        {badge > 0 && <span className="bell-badge">{badge}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-panel-header">
            <span>Thông báo</span>
            <button className="btn btn-sm" onClick={markAll} disabled={!hasUnread}>
              Đánh dấu tất cả đã đọc
            </button>
          </div>
          {listQuery.isLoading ? (
            <Loading inline label="Đang tải thông báo…" />
          ) : listQuery.error ? (
            <ErrorMessage error={listQuery.error} />
          ) : items.length === 0 ? (
            <Empty label="Chưa có thông báo nào." icon="bell" />
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={`bell-item ${n.read ? '' : 'unread'}`}
                onClick={() => {
                  if (!n.read) markReadMutation.mutate(n.id);
                }}
              >
                <div>{n.message}</div>
                <div className="bell-item-meta">
                  {[n.kind, n.refType, formatDate(n.createdAt)].filter(Boolean).join(' · ')}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
