/**
 * Marketing autopilot route registration (customer: Thanh Giang — XKLĐ).
 *
 * Exposes the ONE data-driven, performance-first loop (research → plan →
 * generate + assets → human review gate → schedule → summary) behind the
 * Foundation auth + RBAC middleware. All routes use module 'generation'
 * (ADMIN-only by current policy; SALES is denied on the generation module) under
 * the /api/v1 prefix:
 *   - POST /api/v1/autopilot/run             -> start a run (create)
 *   - GET  /api/v1/autopilot/runs/:id        -> run + steps (read)
 *   - POST /api/v1/autopilot/runs/:id/approve-> resume after human review (status_update)
 *   - POST /api/v1/autopilot/runs/:id/cancel -> cancel a run (status_update)
 *
 * This registrar is ADDITIVE — it does NOT touch routes/index.ts. It constructs
 * the marketing services it orchestrates from the shared deps and wires them
 * into the AutopilotService. The main agent wires this into app.ts.
 *
 * HONESTY NOTE: generation requires a configured Gemini key. When unconfigured,
 * MultiFormatGenerator throws 502 (AI_NOT_CONFIGURED) per item; the autopilot
 * treats that as a SOFT per-item skip (recorded), so a run still advances and
 * pauses at the review gate. Items on non-DraftPlatform channels (youtube /
 * zalo / email) are GENERATED (draft + asset) but NOT scheduled.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import type { Action, Module } from '../../auth/rbac';
import type { ContentGenerator } from '../../strategy/personaService';
import { requireAuth, rbacGuard, getAuth } from '../../http/authMiddleware';
import { ValidationError } from '../../infra/errors';
import type { EventBus } from '../../infra/events';
import { PrismaAiPromptContextReader } from '../../content/generationService';
import { SchedulingService } from '../../content/schedulingService';
import { MediaService } from '../../content/mediaService';
import { TrendResearchService } from '../research/trendResearchService';
import { ContentPlanner } from '../planning/contentPlanner';
import { MultiFormatGenerator } from '../content/multiFormatGenerator';
import { AssetGenerator } from '../assets/assetGenerator';
import type { RenderProvider } from '../assets/assetGenerator';
import { AutopilotService } from './autopilotService';
import type { BrandKnowledgeProvider } from '../brandKnowledge';

export interface AutopilotRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  eventBus: EventBus;
  /** Gemini seam; generation rethrows 502 AI_NOT_CONFIGURED when unconfigured. */
  gemini: ContentGenerator;
  /**
   * Optional image/video render provider. When wired, autopilot-generated
   * assets render to RENDERED/FAILED; when absent they stay SPEC_READY.
   */
  renderProvider?: RenderProvider;
  /**
   * Optional brand-knowledge grounding seam. When present, autopilot-generated
   * content / research / planning are grounded in the Thanh Giang knowledge base.
   */
  brandKnowledge?: BrandKnowledgeProvider;
}

interface IdParams {
  id: string;
}

function guard(module: Module, action: Action) {
  return rbacGuard(() => ({ module, action }));
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  return v === true || v === 'true';
}

export function registerAutopilotRoutes(app: FastifyInstance, deps: AutopilotRouteDeps): void {
  const { prisma, jwt, eventBus, gemini, brandKnowledge } = deps;
  const auth = requireAuth({ prisma, jwt });

  // Construct the marketing services the autopilot orchestrates. The shared
  // brand-knowledge provider grounds the AI generators so autopilot-generated
  // content is on-brand too (optional / non-breaking when absent).
  const trendResearch = new TrendResearchService(prisma, gemini, brandKnowledge);
  const contentPlanner = new ContentPlanner(prisma, gemini, brandKnowledge);
  const multiFormatGenerator = new MultiFormatGenerator(
    prisma,
    gemini,
    new PrismaAiPromptContextReader(prisma),
    brandKnowledge,
  );
  const assetGenerator = new AssetGenerator(prisma, deps.renderProvider);
  const schedulingService = new SchedulingService(prisma, new MediaService(prisma), undefined, eventBus);

  const autopilot = new AutopilotService(prisma, eventBus, {
    trendResearch,
    contentPlanner,
    multiFormatGenerator,
    assetGenerator,
    schedulingService,
  });

  // Start an autopilot run (pauses at review_gate when requireApproval).
  app.post(
    '/api/v1/autopilot/run',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const market = asString(body.market);
      const objective = asString(body.objective);
      const periodFrom = asString(body.periodFrom);
      const periodTo = asString(body.periodTo);
      if (!market) throw new ValidationError('market is required', 'AUTOPILOT_MARKET_REQUIRED');
      if (!objective) throw new ValidationError('objective is required', 'AUTOPILOT_OBJECTIVE_REQUIRED');
      if (!periodFrom) throw new ValidationError('periodFrom is required', 'AUTOPILOT_PERIOD_FROM_REQUIRED');
      if (!periodTo) throw new ValidationError('periodTo is required', 'AUTOPILOT_PERIOD_TO_REQUIRED');

      const run = await autopilot.run(
        {
          market,
          objective,
          periodFrom,
          periodTo,
          channels: asStringArray(body.channels),
          domainName: asString(body.domainName),
          personaIds: asStringArray(body.personaIds),
          requireApproval: asBool(body.requireApproval),
        },
        getAuth(request).userId,
      );
      return reply.code(201).send({ runId: run.id, status: run.status, currentStep: run.currentStep });
    },
  );

  // Get a run + its steps.
  app.get(
    '/api/v1/autopilot/runs/:id',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const run = await autopilot.get(id);
      return reply.code(200).send(run);
    },
  );

  // Approve (resume) a run waiting at the human review gate.
  app.post(
    '/api/v1/autopilot/runs/:id/approve',
    { preHandler: [auth, guard('generation', 'status_update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const run = await autopilot.approve(id);
      return reply.code(200).send({ runId: run.id, status: run.status, currentStep: run.currentStep });
    },
  );

  // Cancel a run.
  app.post(
    '/api/v1/autopilot/runs/:id/cancel',
    { preHandler: [auth, guard('generation', 'status_update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const run = await autopilot.cancel(id);
      return reply.code(200).send({ runId: run.id, status: run.status, currentStep: run.currentStep });
    },
  );
}
