/**
 * Follow-up (nurture) route registration (Feature 3). Thin Fastify layer behind
 * requireAuth + rbacGuard(lead_management). Reads are allowed for SALES+ADMIN;
 * scan/send/cancel are writes (lead_management/update). Additive registrar.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard } from '../http/authMiddleware';
import { FollowUpService } from './followUpService';
import type { ChannelSender } from './intakeService';

export interface FollowUpRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Outbound transport; defaults to no-op when no messaging tokens are wired. */
  sender?: ChannelSender;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function registerFollowUpRoutes(app: FastifyInstance, deps: FollowUpRouteDeps): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const service = new FollowUpService(prisma, deps.sender);

  const readGuard = rbacGuard(() => ({ module: 'lead_management', action: 'read' }));
  const writeGuard = rbacGuard(() => ({ module: 'lead_management', action: 'update' }));

  app.get(
    '/api/v1/follow-ups',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await service.list(asString(q.status), asInt(q.page, 1), asInt(q.limit, 20));
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
