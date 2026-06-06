/**
 * Analytics & Feedback Loop HTTP routes (design Req 23).
 *
 * Thin Fastify layer: shapes requests/responses and wires Foundation auth +
 * RBAC; all domain logic lives in the services. Route-to-policy binding:
 *   - /api/analytics/collect, /score          -> module 'analytics'
 *   - /api/feedback/analyze, /insights, ...    -> module 'feedback' (ADMIN only;
 *                                                 SALES is denied on feedback)
 *   - /api/strategy/ai-context (GET)           -> module 'strategy' (read)
 *
 * This module registers its own routes; it does NOT touch routes/index.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { AppConfig } from '../infra/config';
import type { ContentGenerator } from '../strategy/personaService';
import type { AlertDispatcher } from '../infra/alerts';
import type { AdapterRegistry } from '../platforms/registry';
import type { EventBus } from '../infra/events';
import { getAuth, rbacGuard, requireAuth } from '../http/authMiddleware';
import { ValidationError } from '../infra/errors';
import { CollectionService } from './collectionService';
import type { TokenGate } from './collectionService';
import { ScoringService } from './scoringService';
import { FeedbackEngine } from './feedbackEngine';
import { InsightService } from './insightService';
import { DEFAULT_SCORING_CONFIG } from './scoring';
import { DEFAULT_FEEDBACK_CONFIG } from './types';
import { StrategyUpdateProcessor } from '../strategy/strategyUpdateProcessor';
import { AiContextReadModel } from '../strategy/aiContextReadModel';

export interface AnalyticsRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  config: AppConfig;
  gemini: ContentGenerator;
  registry: AdapterRegistry;
  tokenManager: TokenGate;
  alerts: AlertDispatcher;
  /** Shared domain event bus; when present, insight 'pending' events publish. */
  eventBus?: EventBus;
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

function asRecordBody(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  deps: AnalyticsRouteDeps,
): Promise<void> {
  const { prisma, jwt, gemini, registry, tokenManager, alerts } = deps;

  const auth = requireAuth({ prisma, jwt });

  const collectionService = new CollectionService(prisma, registry, tokenManager, alerts);
  const scoringService = new ScoringService(prisma, DEFAULT_SCORING_CONFIG);
  const feedbackEngine = new FeedbackEngine(prisma, gemini, DEFAULT_FEEDBACK_CONFIG, alerts, undefined, deps.eventBus);
  const strategyProcessor = new StrategyUpdateProcessor(prisma);
  const insightService = new InsightService(prisma, strategyProcessor);
  const aiContext = new AiContextReadModel(prisma);

  // RBAC guards. feedback/analytics writes are ADMIN-only (SALES denied on both
  // modules by policy); ai-context is a strategy read.
  const analyticsGuard = rbacGuard(() => ({ module: 'analytics', action: 'update' }));
  const feedbackWriteGuard = rbacGuard(() => ({ module: 'feedback', action: 'update' }));
  const feedbackReadGuard = rbacGuard(() => ({ module: 'feedback', action: 'read' }));
  const strategyReadGuard = rbacGuard(() => ({ module: 'strategy', action: 'read' }));

  // ---- Analytics: collection + scoring --------------------------------------
  app.post(
    '/api/analytics/collect',
    { preHandler: [auth, analyticsGuard] },
    async (_request, reply) => {
      const report = await collectionService.runCycle();
      return reply.code(200).send(report);
    },
  );

  app.post(
    '/api/analytics/score',
    { preHandler: [auth, analyticsGuard] },
    async (request, reply) => {
      const body = asRecordBody(request.body);
      const postId = asString(body.postId) ?? asString(body.publishedPostId);
      if (!postId) {
        throw new ValidationError('postId is required', 'MISSING_POST_ID');
      }
      const scored = await scoringService.scoreByPost(postId);
      if (!scored) {
        return reply.code(200).send({ scored: false, postId });
      }
      return reply.code(200).send({ scored: true, performance: scored });
    },
  );

  // ---- Feedback: analyze + insight review -----------------------------------
  app.post(
    '/api/feedback/analyze',
    { preHandler: [auth, feedbackWriteGuard] },
    async (_request, reply) => {
      const result = await feedbackEngine.run();
      const code = result.outcome === 'failed' ? 502 : 200;
      return reply.code(code).send(result);
    },
  );

  app.get(
    '/api/feedback/insights',
    { preHandler: [auth, feedbackReadGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await insightService.listPending(asInt(q.page, 1), asInt(q.limit, 20));
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/feedback/insights/:id',
    { preHandler: [auth, feedbackReadGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const result = await insightService.open(id);
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/api/feedback/insights/:id/apply',
    { preHandler: [auth, feedbackWriteGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const actor = getAuth(request).userId;
      const result = await insightService.approve(id, actor);
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/api/feedback/insights/:id/reject',
    { preHandler: [auth, feedbackWriteGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const actor = getAuth(request).userId;
      const body = asRecordBody(request.body);
      const reason = asString(body.reason) ?? '';
      const result = await insightService.reject(id, actor, reason);
      return reply.code(200).send(result);
    },
  );

  // Optional: persist a modified recommended change before approval (Req 18.4).
  app.post(
    '/api/feedback/insights/:id/modify',
    { preHandler: [auth, feedbackWriteGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = asRecordBody(request.body);
      const edited = asRecordBody(body.modifiedChange ?? body);
      const result = await insightService.modify(id, edited);
      return reply.code(200).send(result);
    },
  );

  // ---- Strategy: AI prompt context (read; cold-start empty, never error) -----
  app.get(
    '/api/strategy/ai-context',
    { preHandler: [auth, strategyReadGuard] },
    async (_request: FastifyRequest, reply) => {
      const context = await aiContext.get();
      return reply.code(200).send(context);
    },
  );
}
