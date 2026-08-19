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
import { validateBody, validateParams, validateQuery, UUID, MarketEnum, TrimmedString } from '../../http/validation';
import { z } from 'zod';

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

  // Zod schemas for planning routes.
  const TrendResearchBody = z.object({ market: MarketEnum });
  const TrendReviewBody = z.object({ status: z.enum(['ADOPTED', 'REJECTED', 'ARCHIVED']) });
  const TrendQuerySchema = z.object({
    market: MarketEnum.optional(),
    status: z.enum(['DISCOVERED', 'ADOPTED', 'REJECTED', 'ARCHIVED']).optional(),
  });
  const PlanCreateBody = z.object({
    market: MarketEnum,
    objective: TrimmedString(100),
    periodFrom: z.string().min(1),
    periodTo: z.string().min(1),
    channels: z.array(z.string().trim().max(50)).max(10).default([]),
  });
  const PlanQuerySchema = z.object({
    market: MarketEnum.optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED']).optional(),
  });

  // ---- Trend research --------------------------------------------------------
  app.post(
    '/api/v1/trends/research',
    { preHandler: [auth, stratCreate, validateBody(TrendResearchBody)] },
    async (request, reply) => {
      const body = (request as unknown as { validatedBody: { market: string } }).validatedBody;
      const result = await research.research(body.market);
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/api/v1/trends',
    { preHandler: [auth, stratRead, validateQuery(TrendQuerySchema)] },
    async (request, reply) => {
      const q = (request as unknown as { validatedQuery: { market?: string; status?: string } }).validatedQuery;
      const signals = await research.list(q.market, q.status);
      return reply.code(200).send({ trends: signals });
    },
  );

  app.post(
    '/api/v1/trends/:id/review',
    { preHandler: [auth, stratUpdate, validateParams(z.object({ id: UUID })), validateBody(TrendReviewBody)] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const body = (request as unknown as { validatedBody: { status: string } }).validatedBody;
      const signal = await research.review(id, body.status);
      return reply.code(200).send(signal);
    },
  );

  // ---- Content plans ---------------------------------------------------------
  app.post(
    '/api/v1/content-plans',
    { preHandler: [auth, stratCreate, validateBody(PlanCreateBody)] },
    async (request, reply) => {
      const body = (request as unknown as { validatedBody: z.infer<typeof PlanCreateBody> }).validatedBody;
      const periodFrom = parseIsoDate(body.periodFrom, 'PLAN_PERIOD_FROM_INVALID');
      const periodTo = parseIsoDate(body.periodTo, 'PLAN_PERIOD_TO_INVALID');

      const plan = await planner.generatePlan({
        market: body.market,
        objective: body.objective,
        periodFrom,
        periodTo,
        channels: body.channels,
        createdBy: getAuth(request).userId,
      });
      return reply.code(201).send(plan);
    },
  );

  app.get(
    '/api/v1/content-plans',
    { preHandler: [auth, stratRead, validateQuery(PlanQuerySchema)] },
    async (request, reply) => {
      const q = (request as unknown as { validatedQuery: { market?: string; status?: string } }).validatedQuery;
      const plans = await planner.list(q.market, q.status);
      return reply.code(200).send({ plans });
    },
  );

  app.get(
    '/api/v1/content-plans/:id',
    { preHandler: [auth, stratRead, validateParams(z.object({ id: UUID }))] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const plan = await planner.get(id);
      return reply.code(200).send(plan);
    },
  );

  app.post(
    '/api/v1/content-plans/:id/activate',
    { preHandler: [auth, stratUpdate, validateParams(z.object({ id: UUID }))] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const plan = await planner.activate(id);
      return reply.code(200).send(plan);
    },
  );

  app.post(
    '/api/v1/content-plans/:id/archive',
    { preHandler: [auth, stratUpdate] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const plan = await planner.archive(id);
      return reply.code(200).send(plan);
    },
  );

  app.get(
    '/api/v1/content-plans/:id/items',
    { preHandler: [auth, stratRead, validateParams(z.object({ id: UUID }))] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const items = await planner.listItems(id);
      return reply.code(200).send({ items });
    },
  );

  app.post(
    '/api/v1/content-plans/items/:itemId/mark',
    { preHandler: [auth, stratUpdate, validateParams(z.object({ itemId: UUID })), validateBody(z.object({ status: z.string().min(1), draftId: UUID.optional() }))] },
    async (request, reply) => {
      const { itemId } = (request as unknown as { validatedParams: { itemId: string } }).validatedParams;
      const body = (request as unknown as { validatedBody: { status: string; draftId?: string } }).validatedBody;
      const item = await planner.markItem(itemId, body.status, body.draftId);
      return reply.code(200).send(item);
    },
  );
}
