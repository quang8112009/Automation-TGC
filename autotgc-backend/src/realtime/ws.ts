/**
 * WebSocket transport for the real-time client layer.
 *
 * Exposes GET /api/v1/ws. The JWT may arrive either as a `?access_token=` query
 * parameter or as the first message frame. The token is verified with
 * JwtService.verify(token, 'access'); on failure the server sends an
 * { type: 'error', code: 'UNAUTHORIZED' } frame and closes. Once authenticated,
 * the connection subscribes to the domain event bus and forwards each
 * DomainEvent as a JSON text frame, applying role-based topic authorization
 * (ADMIN: all; SALES: lead + notification). Client { type: 'ping' } frames are
 * answered with { type: 'pong' }.
 *
 * @fastify/websocket v10 handler signature: (socket, request) where `socket` is
 * the raw ws WebSocket. Tokens are never logged; the bus subscription is torn
 * down on 'close' so nothing leaks.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { JwtService, Role } from '../auth/jwt';
import type { DomainEvent, EventBus } from '../infra/events';
import { readQueryString, shouldForward } from './topics';

export interface WebsocketDeps {
  jwt: JwtService;
  eventBus: EventBus;
}

/** Raw message payloads ws may deliver. */
type WsData = string | Buffer | ArrayBuffer | Buffer[];

/**
 * Minimal structural view of the ws WebSocket we depend on. Declared locally
 * because the `ws` package ships no bundled types and `@types/ws` is not a
 * dependency; this keeps the code strict without an implicit any.
 */
interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: WsData) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

/** Control frames a client may send. */
interface ClientFrame {
  type?: string;
  token?: string;
}

/** Normalize any ws payload into a UTF-8 string. */
function toText(data: WsData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Best-effort parse of a client text frame into a typed control object. */
function parseFrame(text: string): ClientFrame | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') return value as ClientFrame;
  } catch {
    // not JSON
  }
  return undefined;
}

/** The JWT carried by the first message: raw token, or { token } / { type:'auth', token }. */
function tokenFromMessage(frame: ClientFrame | undefined, rawText: string): string {
  if (frame && typeof frame.token === 'string' && frame.token.trim().length > 0) {
    return frame.token.trim();
  }
  return rawText.trim();
}

/**
 * Register the @fastify/websocket plugin (guarded against double-registration)
 * and mount the GET /api/v1/ws endpoint.
 */
export async function registerWebsocket(app: FastifyInstance, deps: WebsocketDeps): Promise<void> {
  if (!app.hasDecorator('websocketServer')) {
    await app.register(websocketPlugin);
  }

  app.get('/api/v1/ws', { websocket: true }, (socket: WsSocket, request: FastifyRequest): void => {
    let role: Role | null = null;
    let authStarted = false;
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const forward = (event: DomainEvent): void => {
      if (closed || role === null) return;
      if (!shouldForward(role, event.topic, null)) return;
      socket.send(
        JSON.stringify({
          topic: event.topic,
          type: event.type,
          payload: event.payload,
          at: event.at,
        }),
      );
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const failAuth = (): void => {
      if (closed) return;
      socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED' }));
      cleanup();
      socket.close(1008, 'Unauthorized'); // 1008 = policy violation
    };

    const startAuth = async (token: string): Promise<void> => {
      authStarted = true;
      try {
        const claims = await deps.jwt.verify(token, 'access');
        if (closed) return;
        role = claims.role;
        unsubscribe = deps.eventBus.subscribe(forward);
        socket.send(JSON.stringify({ type: 'ready' }));
      } catch {
        failAuth();
      }
    };

    // Attach the message handler synchronously so no frames are dropped while
    // the async token verification is in flight.
    socket.on('message', (data: WsData): void => {
      if (closed) return;
      const text = toText(data);
      const frame = parseFrame(text);

      if (role === null) {
        // Not yet authenticated. Ignore frames while an auth attempt from the
        // query-string token is already running; otherwise treat this frame as
        // the JWT.
        if (authStarted) return;
        void startAuth(tokenFromMessage(frame, text));
        return;
      }

      // Authenticated control frames.
      if (frame && frame.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    // If the token was supplied via the query string, authenticate immediately.
    const queryToken = readQueryString(request.query, 'access_token');
    if (queryToken && queryToken.trim().length > 0) {
      void startAuth(queryToken.trim());
    }
  });
}
