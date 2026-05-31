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
    sink.info(
      {
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'request completed',
    );
  });
}
