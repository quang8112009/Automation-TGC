/**
 * Follow-up (nurture) route registration (Feature 3). Thin Fastify layer behind
 * requireAuth + rbacGuard(lead_management). Reads are allowed for SALES+ADMIN;
 * scan/send/cancel are writes (lead_management/update). Additive registrar.
 *
 * Assigned-only scoping (sales-access-restrictions, Req 3.5/3.6): the GET
 * /api/v1/follow-ups list read passes the caller (getAuth(request)) as the
 * actor down to FollowUpService.list, which restricts SALES to follow-up tasks
 * whose candidate they are the Assigned_Owner of (tasks without an owned
 * candidate are excluded, fail-closed). ADMIN sees all tasks. The scan/send-due
 * /cancel routes are background/ADMIN-style writes guarded by
 * lead_management/update and are intentionally not per-candidate scoped here.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import { FollowUpService } from './followUpService';
import type { ChannelSender } from './intakeService';

export interface FollowUpRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Outbound transport; defaults to no-op when no messaging tokens are wired. */
  sender?: ChannelSender;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function registerFollowUpRoutes(app: FastifyInstance, deps: FollowUpRouteDeps): Promise<void> {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const service = new FollowUpService(prisma, deps.sender);

  const readGuard = rbacGuard(() => ({ module: 'lead_management', action: 'read' }), auditor);
  const writeGuard = rbacGuard(() => ({ module: 'lead_management', action: 'update' }), auditor);

  app.get(
    '/api/v1/follow-ups',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await service.list(asString(q.status), asInt(q.page, 1), asInt(q.limit, 20), getAuth(request));
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/api/v1/follow-ups/scan',
    { preHandler: [auth, writeGuard] },
    async (_request, reply) => {
      const result = await service.scanDropOffs();
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/api/v1/follow-ups/send-due',
    { preHandler: [auth, writeGuard] },
    async (_request, reply) => {
      const result = await service.sendDue();
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/api/v1/follow-ups/:id/cancel',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await service.cancel(id);
      return reply.code(200).send(result);
    },
  );
}
