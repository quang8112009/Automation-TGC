/**
 * Server-Sent Events (SSE) transport for the real-time client layer.
 *
 * Exposes GET /api/v1/stream (and the /api/stream alias). EventSource cannot
 * set custom headers, so the practical authentication path is a `?access_token`
 * query parameter; an Authorization: Bearer header is also accepted as a
 * fallback. Once authenticated, the connection subscribes to the domain event
 * bus and streams each DomainEvent as a named SSE frame, applying role-based
 * topic authorization (ADMIN: all; SALES: lead + notification) plus an optional
 * client `?topics=` filter.
 *
 * Tokens are never logged. Heartbeat timers and bus subscriptions are always
 * torn down on disconnect so nothing leaks.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService, Role } from '../auth/jwt';
import type { DomainEvent, EventBus } from '../infra/events';
import { UnauthorizedError } from '../infra/errors';
import { parseTopicFilter, readQueryString, shouldForward } from './topics';

/** Heartbeat interval (ms). Keeps proxies/clients from idling the stream out. */
const HEARTBEAT_MS = 25_000;

export interface SseDeps {
  jwt: JwtService;
  prisma: PrismaClient;
  eventBus: EventBus;
}

/** Routes the SSE endpoint is mounted on (canonical + alias). */
const SSE_PATHS: readonly string[] = ['/api/v1/stream', '/api/stream'];

/**
 * Extract the JWT from the query string (`?access_token=`) or, as a fallback,
 * an Authorization: Bearer header. Returns undefined when neither is present.
 */
function extractToken(request: FastifyRequest): string | undefined {
  const fromQuery = readQueryString(request.query, 'access_token');
  if (fromQuery && fromQuery.trim().length > 0) return fromQuery.trim();

  const header = request.headers.authorization;
  if (header) {
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token && token.trim().length > 0) {
      return token.trim();
    }
  }
  return undefined;
}

/** Authenticate an SSE request, returning the principal's role. */
async function authenticate(request: FastifyRequest, deps: SseDeps): Promise<Role> {
  const token = extractToken(request);
  if (!token) {
    throw new UnauthorizedError('Missing access token');
  }
  let role: Role;
  try {
    const claims = await deps.jwt.verify(token, 'access');
    role = claims.role;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
  return role;
}

/** Register the Server-Sent Events endpoint(s). */
export function registerSse(app: FastifyInstance, deps: SseDeps): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Authenticate BEFORE switching the response into streaming mode so that a
    // failure produces a normal 401 envelope via the global error handler.
    const role = await authenticate(request, deps);

    const filter = parseTopicFilter(readQueryString(request.query, 'topics'));

    // Begin the event stream. Take over the raw response; Fastify must not try
    // to serialize a body for us.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable proxy buffering (nginx)
    });
    // Prime the stream so clients receive headers immediately.
    raw.write(': connected\n\n');

    let closed = false;

    const heartbeat = setInterval(() => {
      if (closed) return;
      raw.write(':\n\n');
    }, HEARTBEAT_MS);
    // Don't let the heartbeat keep the event loop alive on shutdown.
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const unsubscribe = deps.eventBus.subscribe((event: DomainEvent) => {
      if (closed) return;
      if (!shouldForward(role, event.topic, filter)) return;
      const data = JSON.stringify({
        topic: event.topic,
        type: event.type,
        payload: event.payload,
        at: event.at,
      });
      raw.write(`event: ${event.topic}\ndata: ${data}\n\n`);
    });

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    // Tear down on client disconnect or transport error.
    request.raw.on('close', cleanup);
    raw.on('close', cleanup);
    raw.on('error', cleanup);
  };

  for (const path of SSE_PATHS) {
    app.get(path, handler);
  }
}
