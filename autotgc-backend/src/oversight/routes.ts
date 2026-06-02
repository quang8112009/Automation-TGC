/**
 * Notification + Activity route registration (design §8, Req 9, 6.5, 8.7).
 *
 * Thin Fastify layer: shapes requests/responses, wires auth + RBAC, and
 * delegates to `NotificationService` / `ActivityLogger`. Mirrors the
 * registration style of `recruitment/documents/routes.ts` (requireAuth +
 * rbacGuard + getAuth).
 *
 * Routing policy (per the design's API Endpoints table):
 *   - GET  /api/v1/notifications              -> dashboard/read  (ADMIN + SALES, self)
 *   - GET  /api/v1/notifications/unread-count -> dashboard/read  (ADMIN + SALES, self)
 *   - POST /api/v1/notifications/:id/read     -> dashboard/read; ownership (403) and
 *                                                existence (404) enforced inside the service
 *   - GET  /api/v1/activity                   -> dashboard/company_stats (ADMIN-only; SALES 403)
 *
 * Both notification reads use the `dashboard/read` policy so each role can read
 * its OWN notifications; the per-record owner check lives in
 * `NotificationService.markRead`. The activity feed uses the ADMIN-only
 * `company_stats` action so the company-wide ledger is locked to ADMIN.
 *
 * All routes mount behind requireAuth + rbacGuard and return only allowed status
 * codes. This file is additive; `app.ts` wiring is task 8.1.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { EventBus } from '../infra/events';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import { ActivityLogger } from './activityLogger';
import { NotificationService } from './notificationService';

export interface OversightRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Shared domain event bus; when present, notification creation publishes. */
  eventBus?: EventBus;
}

interface IdParams {
  id: string;
}

/** Narrow an unknown query value to a positive integer, else fall back. */
function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function registerOversightRoutes(
  app: FastifyInstance,
  deps: OversightRouteDeps,
): Promise<void> {
  const { prisma, jwt, eventBus } = deps;
  const auth = requireAuth({ prisma, jwt });
  const notifications = new NotificationService(prisma, eventBus);
  const activityLogger = new ActivityLogger(prisma);

  // Both roles may read their OWN notifications -> dashboard/read.
  const selfReadGuard = rbacGuard(() => ({ module: 'dashboard', action: 'read' }));
  // Company-wide activity ledger is ADMIN-only -> dashboard/company_stats.
  const activityGuard = rbacGuard(() => ({ module: 'dashboard', action: 'company_stats' }));

  // ---- Notifications --------------------------------------------------------
  // GET /api/v1/notifications — caller's notifications, newest first (Req 9.1).
  app.get(
    '/api/v1/notifications',
    { preHandler: [auth, selfReadGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await notifications.list(actor.userId, asInt(q.page, 1), asInt(q.limit, 50));
      return reply.code(200).send(result);
    },
  );

  // GET /api/v1/notifications/unread-count — caller's unread count (Req 9.4).
  // Registered before '/:id/read' so the static path takes precedence.
  app.get(
    '/api/v1/notifications/unread-count',
    { preHandler: [auth, selfReadGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const count = await notifications.unreadCount(actor.userId);
      return reply.code(200).send({ count });
    },
  );

  // POST /api/v1/notifications/:id/read — idempotent mark-as-read. The service
  // enforces owner-only (403) and existence (404) — Req 9.2, 9.3, 9.5, 9.6.
  app.post(
    '/api/v1/notifications/:id/read',
    { preHandler: [auth, selfReadGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const notification = await notifications.markRead(id, actor.userId);
      return reply.code(200).send(notification);
    },
  );

  // ---- Activity feed (ADMIN-only) -------------------------------------------
  // GET /api/v1/activity — Recent_Activity_Feed, newest first, paginated
  // (Req 6.5). SALES is denied 403 by the company_stats policy.
  app.get(
    '/api/v1/activity',
    { preHandler: [auth, activityGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await activityLogger.listRecent(asInt(q.page, 1), asInt(q.limit, 50));
      return reply.code(200).send(result);
    },
  );
}
