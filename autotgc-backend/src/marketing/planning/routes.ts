/**
 * HTTP routes for the AI marketing autopilot: market trend research + market
 * content planning. Thin layer — shapes requests/responses, wires auth + RBAC,
 * and delegates to TrendResearchService / ContentPlanner.
 *
 * RBAC: every route is behind requireAuth + rbacGuard with module 'strategy'
 * (ADMIN-only by current policy — SALES is denied on the strategy module).
 *
 * Gemini is OPTIONAL throughout: research falls back to a deterministic heuristic
 * seed set and planning uses a deterministic distributor, so both features work
 * with no Gemini key. Validation problems map through the standard AppError
 * envelope (400); illegal lifecycle moves return 409.
 *
 * Both the trend routes AND the plan routes are registered here so app.ts has a
 * single wiring call for the whole domain.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import type { ContentGenerator } from '../../strategy/personaService';
import { requireAuth, rbacGuard, getAuth } from '../../http/authMiddleware';
import { ValidationError } from '../../infra/errors';
import { TrendResearchService } from '../research/trendResearchService';
import { ContentPlanner } from './contentPlanner';
import type { BrandKnowledgeProvider } from '../brandKnowledge';

export interface MarketingPlanningRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; when absent research + planning use deterministic paths. */
  gemini?: ContentGenerator;
  /** Optional brand-knowledge grounding seam; grounds the AI research/reorder prompts. */
  brandKnowledge?: BrandKnowledgeProvider;
}

interface IdParams {
  id: string;
}

interface ItemIdParams {
  itemId: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

/** Parse an ISO date string into a Date or throw a 400. */
function parseIsoDate(v: unknown, code: string): Date {
  const s = asString(v);
  if (!s) {
    throw new ValidationError('A valid ISO date is required', code);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('A valid ISO date is required', code);
  }
  return d;
}

export function registerMarketingPlanningRoutes(
  app: FastifyInstance,
  deps: MarketingPlanningRouteDeps,
): void {
  const { prisma, jwt, gemini, brandKnowledge } = deps;
  const research = new TrendResearchService(prisma, gemini, brandKnowledge);
  const planner = new ContentPlanner(prisma, gemini, brandKnowledge);
  const auth = requireAuth({ prisma, jwt });

  // All routes use the 'strategy' module (ADMIN-only policy).
  const stratRead = rbacGuard(() => ({ module: 'strategy', action: 'read' }));
  const stratCreate = rbacGuard(() => ({ module: 'strategy', action: 'create' }));
  const stratUpdate = rbacGuard(() => ({ module: 'strategy', action: 'update' }));

  // ---- Trend research --------------------------------------------------------
  app.post(
    '/api/v1/trends/research',
    { preHandler: [auth, stratCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const market = asString(body.market);
      if (!market) {
        throw new ValidationError('market is required', 'TREND_MARKET_REQUIRED');
      }
      const result = await research.research(market);
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/api/v1/trends',
    { preHandler: [auth, stratRead] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const signals = await research.list(asString(q.market), asString(q.status));
      return reply.code(200).send({ trends: signals });
    },
  );

  app.post(
    '/api/v1/trends/:id/review',
    { preHandler: [auth, stratUpdate] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const status = asString(body.status);
      if (!status) {
        throw new ValidationError('status is required', 'TREND_REVIEW_STATUS_REQUIRED');
      }
      const signal = await research.review(id, status);
      return reply.code(200).send(signal);
    },
  );

  // ---- Content plans ---------------------------------------------------------
  app.post(
    '/api/v1/content-plans',
    { preHandler: [auth, stratCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const market = asString(body.market);
      const objective = asString(body.objective);
      if (!market) {
        throw new ValidationError('market is required', 'PLAN_MARKET_REQUIRED');
      }
      if (!objective) {
        throw new ValidationError('objective is required', 'PLAN_OBJECTIVE_REQUIRED');
      }
      const periodFrom = parseIsoDate(body.periodFrom, 'PLAN_PERIOD_FROM_INVALID');
      const periodTo = parseIsoDate(body.periodTo, 'PLAN_PERIOD_TO_INVALID');

      const plan = await planner.generatePlan({
        market,
        objective,
        periodFrom,
        periodTo,
        channels: asStringArray(body.channels),
        createdBy: getAuth(request).userId,
      });
      return reply.code(201).send(plan);
    },
  );

  app.get(
    '/api/v1/content-plans',
    { preHandler: [auth, stratRead] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const plans = await planner.list(asString(q.market), asString(q.status));
      return reply.code(200).send({ plans });
    },
  );

  app.get(
    '/api/v1/content-plans/:id',
    { preHandler: [auth, stratRead] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const plan = await planner.get(id);
      return reply.code(200).send(plan);
    },
  );

  app.post(
    '/api/v1/content-plans/:id/activate',
    { preHandler: [auth, stratUpdate] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const plan = await planner.activate(id);
      return reply.code(200).send(plan);
    },
  );

  app.post(
    '/api/v1/content-plans/:id/archive',
    { preHandler: [auth, stratUpdate] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const plan = await planner.archive(id);
      return reply.code(200).send(plan);
    },
  );

  app.get(
    '/api/v1/content-plans/:id/items',
    { preHandler: [auth, stratRead] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const items = await planner.listItems(id);
      return reply.code(200).send({ items });
    },
  );

  app.post(
    '/api/v1/content-plans/items/:itemId/mark',
    { preHandler: [auth, stratUpdate] },
    async (request, reply) => {
      const { itemId } = request.params as ItemIdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const status = asString(body.status);
      if (!status) {
        throw new ValidationError('status is required', 'PLAN_ITEM_STATUS_REQUIRED');
      }
      const item = await planner.markItem(itemId, status, asString(body.draftId));
      return reply.code(200).send(item);
    },
  );
}
