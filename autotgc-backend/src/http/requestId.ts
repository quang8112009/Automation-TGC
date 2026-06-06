/**
 * Request correlation + access logging.
 *
 * - Assigns each request an id (incoming `x-request-id` header if present, else a
 *   freshly generated UUID) and echoes it back on the response `x-request-id`.
 * - Emits one structured access-log line per response with method, url, status,
 *   response time (ms) and the request id.
 *
 * Privacy: the Authorization header and request/response bodies are NEVER logged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

/** Minimal structured-logger contract (a pino logger satisfies this). */
export interface RequestLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  child?(bindings: Record<string, unknown>): RequestLogger;
}

// Expose the resolved request id on the request for downstream handlers.
declare module 'fastify' {
  interface FastifyRequest {
    requestId?: string;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Redact sensitive query-string values from a URL before it is logged.
 * The realtime transports (SSE/WebSocket) accept a `?access_token=` JWT because
 * EventSource/browser WebSocket cannot set headers; logging the raw URL would
 * leak that bearer token into access logs. We replace the value of any
 * sensitive param with `[REDACTED]` while preserving the path + other params.
 */
const SENSITIVE_QUERY_PARAMS: readonly string[] = ['access_token', 'token', 'refresh_token'];

export function redactUrl(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const path = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (SENSITIVE_QUERY_PARAMS.includes(key.toLowerCase())) {
        return `${key}=[REDACTED]`;
      }
      return pair;
    })
    .join('&');
  return `${path}?${redacted}`;
}

function resolveIncomingId(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first && first.trim().length > 0) return first.trim();
  } else if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return randomUUID();
}

/**
 * Wire request-id propagation and access logging onto a Fastify instance.
 * Pass a logger (e.g. a pino instance) to control where access lines are written;
 * when omitted, the request's built-in logger is used.
 */
export function registerRequestId(app: FastifyInstance, logger?: RequestLogger): void {
  const accessLog: RequestLogger | undefined =
    logger && typeof logger.child === 'function'
      ? logger.child({ component: 'http' })
      : logger;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = resolveIncomingId(request.headers[REQUEST_ID_HEADER]);
    request.requestId = id;
    reply.header(REQUEST_ID_HEADER, id);
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const sink: RequestLogger | undefined = accessLog ?? (request.log as RequestLogger | undefined);
    if (!sink) return;
    // Deliberately omit headers (incl. Authorization) and bodies from the log entry.
    // The URL is redacted so a `?access_token=` JWT (realtime transports) never
    // lands in access logs.
    sink.info(
      {
        requestId: request.requestId,
        method: request.method,
        url: redactUrl(request.url),
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'request completed',
    );
  });
}
