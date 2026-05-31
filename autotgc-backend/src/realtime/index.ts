/**
 * Real-time client layer (WebSocket + Server-Sent Events) fed by the domain
 * event bus.
 *
 * `registerRealtime` mounts both transports on a Fastify instance. Because both
 * endpoints authenticate via a query-string token (EventSource and browser
 * WebSocket cannot set Authorization headers), they must bypass the global JWT
 * preHandler — they perform their own token verification. Add
 * REALTIME_PUBLIC_PATHS to the auth allow-list (e.g. alongside PUBLIC_PATHS) so
 * the preHandler does not reject the upgrade/stream before it can authenticate.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { EventBus } from '../infra/events';
import { registerSse } from './sse';
import { registerWebsocket } from './ws';

export interface RealtimeDeps {
  jwt: JwtService;
  prisma: PrismaClient;
  eventBus: EventBus;
}

/**
 * Paths that authenticate via query-string token and therefore must be added to
 * the public allow-list (they do their own token check). They are NOT
 * unauthenticated — each verifies a JWT before streaming.
 */
export const REALTIME_PUBLIC_PATHS: readonly string[] = [
  '/api/v1/stream',
  '/api/stream',
  '/api/v1/ws',
];

/** Register both real-time transports (WebSocket first, then SSE). */
export async function registerRealtime(app: FastifyInstance, deps: RealtimeDeps): Promise<void> {
  await registerWebsocket(app, { jwt: deps.jwt, eventBus: deps.eventBus });
  registerSse(app, { jwt: deps.jwt, prisma: deps.prisma, eventBus: deps.eventBus });
}

export type { SseDeps } from './sse';
export type { WebsocketDeps } from './ws';
export {
  ALL_TOPICS,
  SALES_TOPICS,
  isTopicAllowedForRole,
  parseTopicFilter,
  shouldForward,
} from './topics';
