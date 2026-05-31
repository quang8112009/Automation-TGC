/**
 * HTTP routes for the AI recruitment-consultant agent + knowledge base
 * (customer: Thanh Giang Conincon). Thin layer: shapes requests/responses,
 * wires auth + RBAC, and delegates to RecruitmentConsultantAgent / KnowledgeService.
 *
 * RBAC: every route is behind requireAuth + rbacGuard with module 'generation'
 * (ADMIN-only by current policy — SALES is denied on the generation module).
 *
 * The consult/draft endpoints NEVER surface a 502 "AI not configured": the agent
 * returns a deterministic grounded fallback instead, so the feature works with
 * no Gemini key. Validation problems still map through the standard AppError
 * envelope (400).
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import type { ContentGenerator } from '../../strategy/personaService';
import { requireAuth, rbacGuard } from '../../http/authMiddleware';
import { NotFoundError, ValidationError } from '../../infra/errors';
import { KnowledgeService } from '../knowledge/knowledgeService';
import { RecruitmentConsultantAgent } from './consultantAgent';
import type { CandidateContext } from './consultantAgent';

export interface RecruitmentAgentRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; when absent the agent uses grounded fallbacks. */
  gemini?: ContentGenerator;
}

interface IdParams {
  id: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

/** Build a CandidateContext from a stored CandidateProfile row. */
function candidateContextFromProfile(profile: {
  fullName: string;
  desiredMarket: string | null;
  desiredIndustry: string;
  desiredVisaType: string | null;
  gender: string;
  japaneseLevel: string;
}): CandidateContext {
  return {
    fullName: profile.fullName,
    desiredMarket: profile.desiredMarket,
    desiredIndustry: profile.desiredIndustry,
    desiredVisaType: profile.desiredVisaType,
    gender: profile.gender,
    japaneseLevel: profile.japaneseLevel,
  };
}

export function registerRecruitmentAgentRoutes(
  app: FastifyInstance,
  deps: RecruitmentAgentRouteDeps,
): void {
  const { prisma, jwt, gemini } = deps;
  const knowledge = new KnowledgeService(prisma);
  const agent = new RecruitmentConsultantAgent(knowledge, gemini);
  const auth = requireAuth({ prisma, jwt });

  // All AI + knowledge routes use the 'generation' module (ADMIN-only policy).
  const genRead = rbacGuard(() => ({ module: 'generation', action: 'read' }));
  const genCreate = rbacGuard(() => ({ module: 'generation', action: 'create' }));
  const genUpdate = rbacGuard(() => ({ module: 'generation', action: 'update' }));

  // ---- AI consult ------------------------------------------------------------
  app.post(
    '/api/v1/ai/consult',
    { preHandler: [auth, genCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const question = asString(body.question);
      if (!question) {
        throw new ValidationError('question is required', 'AI_QUESTION_REQUIRED');
      }

      let candidate: CandidateContext | undefined;
      const candidateId = asString(body.candidateId);
      if (candidateId) {
        const profile = await prisma.candidateProfile.findUnique({ where: { id: candidateId } });
        if (!profile) {
          throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');
        }
        candidate = candidateContextFromProfile(profile);
      }

      const result = await agent.consult(question, candidate);
      return reply.code(200).send(result);
    },
  );

  // ---- AI suggest job orders -------------------------------------------------
  app.post(
    '/api/v1/ai/suggest-job-orders',
    { preHandler: [auth, genCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const candidateId = asString(body.candidateId);
      if (!candidateId) {
        throw new ValidationError('candidateId is required', 'AI_CANDIDATE_REQUIRED');
      }
      const profile = await prisma.candidateProfile.findUnique({ where: { id: candidateId } });
      if (!profile) {
        throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');
      }

      const openJobOrders = await prisma.jobOrder.findMany({ where: { status: 'OPEN' } });
      const suggestions = agent.suggestJobOrders(
        candidateContextFromProfile(profile),
        openJobOrders,
      );
      return reply.code(200).send({
        candidateId,
        suggestions: suggestions.map((s) => ({
          jobOrderId: s.jobOrder.id,
          code: s.jobOrder.code,
          title: s.jobOrder.title,
          score: s.score,
          reasons: s.reasons,
        })),
      });
    },
  );

  // ---- AI draft outreach -----------------------------------------------------
  app.post(
    '/api/v1/ai/draft-outreach',
    { preHandler: [auth, genCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const candidateId = asString(body.candidateId);
      const jobOrderId = asString(body.jobOrderId);
      if (!candidateId) {
        throw new ValidationError('candidateId is required', 'AI_CANDIDATE_REQUIRED');
      }
      if (!jobOrderId) {
        throw new ValidationError('jobOrderId is required', 'AI_JOB_ORDER_REQUIRED');
      }

      const [profile, jobOrder] = await Promise.all([
        prisma.candidateProfile.findUnique({ where: { id: candidateId } }),
        prisma.jobOrder.findUnique({ where: { id: jobOrderId } }),
      ]);
      if (!profile) {
        throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');
      }
      if (!jobOrder) {
        throw new NotFoundError('Job order not found', 'JOB_ORDER_NOT_FOUND');
      }

      const result = await agent.draftOutreach(candidateContextFromProfile(profile), jobOrder);
      return reply.code(200).send(result);
    },
  );

  // ---- Knowledge base management --------------------------------------------
  app.get(
    '/api/v1/knowledge',
    { preHandler: [auth, genRead] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const entries = await knowledge.list(asString(q.category), asString(q.market));
      return reply.code(200).send({ entries });
    },
  );

  app.post(
    '/api/v1/knowledge',
    { preHandler: [auth, genCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const category = asString(body.category);
      const title = asString(body.title);
      const content = asString(body.content);
      if (!category) throw new ValidationError('category is required', 'KB_CATEGORY_REQUIRED');
      if (!title) throw new ValidationError('title is required', 'KB_TITLE_REQUIRED');
      if (!content) throw new ValidationError('content is required', 'KB_CONTENT_REQUIRED');

      const entry = await knowledge.create({
        category,
        title,
        content,
        tags: asStringArray(body.tags) ?? [],
        market: asString(body.market) ?? null,
      });
      return reply.code(201).send(entry);
    },
  );

  app.put(
    '/api/v1/knowledge/:id',
    { preHandler: [auth, genUpdate] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;

      // Treat an explicit `active: false` as deactivation; otherwise patch fields.
      const patch: Parameters<KnowledgeService['update']>[1] = {};
      if (asString(body.category) !== undefined) patch.category = asString(body.category);
      if (asString(body.title) !== undefined) patch.title = asString(body.title);
      if (asString(body.content) !== undefined) patch.content = asString(body.content);
      if (asStringArray(body.tags) !== undefined) patch.tags = asStringArray(body.tags);
      if (asString(body.market) !== undefined) patch.market = asString(body.market);
      if (typeof body.active === 'boolean') patch.active = body.active;

      const existing = await prisma.knowledgeEntry.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundError('Knowledge entry not found', 'KB_NOT_FOUND');
      }

      const entry = await knowledge.update(id, patch);
      return reply.code(200).send(entry);
    },
  );
}
