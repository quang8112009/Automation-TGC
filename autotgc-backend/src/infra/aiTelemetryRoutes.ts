/**
 * AgentOps telemetry read route (harness layer: AgentOps).
 *
 * Exposes the aggregated AI-text-call telemetry window to operators so the
 * health of the DeepSeek migration is observable (fallback rate, latency
 * percentiles, error-code breakdown). Read-only and ADMIN-only:
 *
 *   GET /api/v1/ai/telemetry  -> dashboard/company_stats (ADMIN only; SALES 403)
 *
 * Thin Fastify layer mirroring `oversight/routes.ts`: requireAuth + rbacGuard,
 * delegates to the pure `aggregateAiTelemetry` via the shared
 * `InMemoryAiTelemetrySink`. Returns only the allowed status codes and never
 * leaks a secret (the telemetry records carry no prompt/response/key).
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard } from '../http/authMiddleware';
import type { InMemoryAiTelemetrySink } from './aiTelemetry';

export interface AiTelemetryRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** The shared AgentOps telemetry sink built in composeServices. */
  aiTelemetry: InMemoryAiTelemetrySink;
}

export async function registerAiTelemetryRoutes(
  app: FastifyInstance,
  deps: AiTelemetryRouteDeps,
): Promise<void> {
  const { prisma, jwt, aiTelemetry } = deps;
  const auth = requireAuth({ prisma, jwt });
  // Company-wide AI ops stats are ADMIN-only.
  const statsGuard = rbacGuard(() => ({ module: 'dashboard', action: 'company_stats' }));

  // GET /api/v1/ai/telemetry — aggregated summary over the retained window.
  app.get('/api/v1/ai/telemetry', { preHandler: [auth, statsGuard] }, async (_request, reply) => {
    return reply.code(200).send(aiTelemetry.summary());
  });
}
