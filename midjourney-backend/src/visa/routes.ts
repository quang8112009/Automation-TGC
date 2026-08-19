/**
 * Visa & Logistics routes — Smart Checklist + logistics plan per candidate, and
 * the destination-suggestion endpoint (đối chiếu DB & gợi ý cho tư vấn).
 *
 * All routes behind requireAuth + rbacGuard(lead_management) so ADMIN has full
 * access and SALES is assigned-only (the services re-check candidate scoping).
 * Additive registrar; app.ts wiring is handled separately.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import type { ContentGenerator } from '../strategy/personaService';
import { VisaService } from './visaService';
import { VisaAdvisor } from './visaAdvisor';
import { DestinationSuggestionService } from '../partners/suggestionService';
import { governanceRoute } from '../governance/middleware';

export interface VisaRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; the visa advisor grounds + phrases advice when present. */
  gemini?: ContentGenerator;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

interface IdParams {
  id: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function registerVisaRoutes(app: FastifyInstance, deps: VisaRouteDeps): Promise<void> {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const visa = new VisaService(prisma);
  const suggestions = new DestinationSuggestionService(prisma);
  const advisor = new VisaAdvisor(deps.gemini);

  const guard = (action: Action) =>
    rbacGuard(() => ({ module: 'lead_management', action }), auditor);

  // ---- Destination suggestions (gợi ý cho tư vấn) ---------------------------
  app.get(
    '/api/v1/candidates/:id/destination-suggestions',
    { preHandler: [auth, guard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await suggestions.suggestForCandidate(id, actor, asInt(q.limit, 10));
      return reply.code(200).send(result);
    },
  );

  // ---- Visa cases (Smart Checklist) -----------------------------------------
  app.post(
    '/api/v1/visa-cases',
    { ...governanceRoute({ audit: true }), preHandler: [auth, guard('create')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const created = await visa.createCase(
        {
          candidateId: asString(body.candidateId),
          country: asString(body.country),
          visaType: asString(body.visaType),
          targetIntakeDate: asString(body.targetIntakeDate),
          submissionDeadline: asString(body.submissionDeadline),
        },
        actor,
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/api/v1/candidates/:id/visa-cases',
    { preHandler: [auth, guard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await visa.listForCandidate(id, actor);
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/v1/visa-cases/:id',
    { preHandler: [auth, guard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await visa.getCase(id, actor);
      return reply.code(200).send(result ?? {});
    },
  );

  // AI-grounded advisory for a visa case (custom AI): summarizes the most-urgent
  // documents/deadlines + recommended insurance/housing/pickup. Gemini-phrased
  // when configured, deterministic grounded fallback otherwise (never 502).
  app.get(
    '/api/v1/visa-cases/:id/advice',
    { preHandler: [auth, guard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const view = (await visa.getCase(id, actor)) as
        | { country?: string; targetIntakeDate?: string | Date | null }
        | null;
      const country = view?.country ?? '';
      const targetIntakeDate = view?.targetIntakeDate ? new Date(view.targetIntakeDate) : null;
      const advice = await advisor.advise({ country, targetIntakeDate });
      return reply.code(200).send(advice);
    },
  );

  app.post(
    '/api/v1/visa-cases/:id/tasks',
    { ...governanceRoute({ audit: true }), preHandler: [auth, guard('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const task = await visa.addTask(
        id,
        {
          label: asString(body.label),
          category: asString(body.category),
          required: body.required === true || body.required === 'true',
          dueAt: asString(body.dueAt),
        },
        actor,
      );
      return reply.code(201).send(task);
    },
  );

  app.put(
    '/api/v1/visa-tasks/:id',
    { ...governanceRoute({ audit: true }), preHandler: [auth, guard('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const task = await visa.updateTask(
        id,
        { status: body.status, dueAt: body.dueAt, note: body.note },
        actor,
      );
      return reply.code(200).send(task);
    },
  );

  // ---- Logistics plan -------------------------------------------------------
  app.post(
    '/api/v1/visa-cases/:id/logistics/generate',
    { preHandler: [auth, guard('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await visa.generateLogistics(id, actor);
      return reply.code(200).send(result);
    },
  );

  app.put(
    '/api/v1/visa-cases/:id/logistics',
    { ...governanceRoute({ audit: true }), preHandler: [auth, guard('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const plan = await visa.updateLogistics(id, (request.body ?? {}) as Record<string, unknown>, actor);
      return reply.code(200).send(plan);
    },
  );
}
