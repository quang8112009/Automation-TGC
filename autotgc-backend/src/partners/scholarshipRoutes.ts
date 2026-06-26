/**
 * Financial & Scholarship Matching route registration (Feature 2).
 *
 * Thin Fastify layer: shapes requests/responses, wires auth + RBAC, and
 * delegates to `ScholarshipService`. Mirrors the registration style of
 * `partners/routes.ts` (requireAuth, rbacGuard, asString/asInt). All financial
 * math stays in the pure `scholarshipMatcher`.
 *
 * RBAC mapping (no policy-table change — see auth/rbac.ts):
 *   - Reads -> module 'lead_management' / 'read' (ADMIN full; SALES allowed; the
 *     candidate-scoped route additionally re-checks assigned ownership inside
 *     the service, matching the assigned-only rule for SALES).
 *
 * Uses the `/api/v1` gateway prefix. All routes mount behind requireAuth +
 * rbacGuard. This file is additive; `app.ts` wiring is handled separately.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import { ScholarshipService } from './scholarshipService';
import type { FinanceOverride } from './scholarshipService';

export interface ScholarshipRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

interface IdParams {
  id: string;
}

/** Narrow an unknown value to a positive int, else the fallback. */
function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Narrow an unknown value to a finite number, else undefined. */
function asNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Build a finance override from a loosely-typed query/body bag. */
function asFinance(src: Record<string, unknown>): FinanceOverride {
  const finance: FinanceOverride = {};
  const budget = asNumber(src.budgetPerYearVndM);
  const gpa = asNumber(src.gpa);
  const ielts = asNumber(src.ielts);
  if (budget !== undefined) finance.budgetPerYearVndM = budget;
  if (gpa !== undefined) finance.gpa = gpa;
  if (ielts !== undefined) finance.ielts = ielts;
  return finance;
}

export async function registerScholarshipRoutes(
  app: FastifyInstance,
  deps: ScholarshipRouteDeps,
): Promise<void> {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const scholarshipService = new ScholarshipService(prisma);

  // Reads map to lead_management/read so SALES can read. The candidate-scoped
  // route re-checks assigned ownership inside the service.
  const readGuard = rbacGuard(() => ({ module: 'lead_management', action: 'read' }), auditor);

  // ---- Candidate scholarship suggestions ------------------------------------
  app.get(
    '/api/v1/candidates/:id/scholarship-suggestions',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const q = (request.query ?? {}) as Record<string, unknown>;
      const actor = getAuth(request);
      const result = await scholarshipService.suggestForCandidate(
        id,
        actor,
        asInt(q.limit, 10),
        asFinance(q),
      );
      return reply.code(200).send(result);
    },
  );

  // ---- Ad-hoc scholarship suggestions (no candidate) ------------------------
  app.post(
    '/api/v1/scholarship-suggestions',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await scholarshipService.suggestForProfile(
        asFinance(body),
        asInt(body.limit, 10),
      );
      return reply.code(200).send(result);
    },
  );
}
