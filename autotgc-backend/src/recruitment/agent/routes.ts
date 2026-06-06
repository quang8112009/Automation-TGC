/**
 * HTTP routes for the AI recruitment-consultant agent + knowledge base
 * (customer: Thanh Giang Conincon). Thin layer: shapes requests/responses,
 * wires auth + RBAC, and delegates to RecruitmentConsultantAgent / KnowledgeService.
 *
 * RBAC: the consult/draft/suggest routes are behind requireAuth + rbacGuard
 * with module 'generation' (ADMIN-only by current policy — SALES is denied on
 * the generation module). The Knowledge_Base management routes use the
 * fine-grained 'knowledge_base' module so SALES can maintain reference material
 * (read/create/update). The Work_Assistant route (/api/v1/ai/assistant) is
 * mapped to module 'dashboard'/'read' so BOTH ADMIN and SALES can reach it; its
 * role-based business-data scoping is enforced inside WorkAssistant.
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
import { requireAuth, rbacGuard, getAuth } from '../../http/authMiddleware';
import { NotFoundError, ValidationError } from '../../infra/errors';
import type { OversightService } from '../../oversight/oversightService';
import { KnowledgeService } from '../knowledge/knowledgeService';
import { RecruitmentConsultantAgent } from './consultantAgent';
import type { CandidateContext } from './consultantAgent';
import { WorkAssistant } from './workAssistant';

export interface RecruitmentAgentRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; when absent the agent uses grounded fallbacks. */
  gemini?: ContentGenerator;
  /** Central oversight emit point; when present, successful Knowledge_Base
   * management actions (create/update/deactivate) append one best-effort
   * ActivityLog record (Req 7.1). App wiring is task 10.1. */
  oversight?: OversightService;
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
  const { prisma, jwt, gemini, oversight } = deps;
  const knowledge = new KnowledgeService(prisma);
  const agent = new RecruitmentConsultantAgent(knowledge, gemini);
  const assistant = new WorkAssistant(knowledge, gemini);
  const auth = requireAuth({ prisma, jwt });

  // The consultant routes use the 'generation' module (ADMIN-only policy;
  // SALES is denied).
  const genCreate = rbacGuard(() => ({ module: 'generation', action: 'create' }));

  // The Knowledge_Base management routes use the fine-grained 'knowledge_base'
  // module (SALES is granted read/create/update; ADMIN is allowed everywhere).
  // This replaces the previous 'generation' guards so SALES can maintain the
  // reference material (Req 1.6–1.9). Deactivation is a PUT with `active:false`,
  // i.e. still the 'update' action.
  const kbRead = rbacGuard(() => ({ module: 'knowledge_base', action: 'read' }));
  const kbCreate = rbacGuard(() => ({ module: 'knowledge_base', action: 'create' }));
  const kbUpdate = rbacGuard(() => ({ module: 'knowledge_base', action: 'update' }));

  // The Work_Assistant must be reachable by BOTH ADMIN and SALES (Req 6 covers
  // all authenticated employees). The RBAC policy in `auth/rbac.ts` denies SALES
  // on 'generation' but ALLOWS SALES a read on 'dashboard'; ADMIN is allowed
  // everywhere. So we map this guard to { module: 'dashboard', action: 'read' }
  // to let both roles through while keeping `rbac.ts` pure (Req 7.4). Role-based
  // business-data scoping is enforced inside WorkAssistant (Req 7.1–7.3).
  const assistantGuard = rbacGuard(() => ({ module: 'dashboard', action: 'read' }));

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

  // ---- Work_Assistant (Trợ lý Công việc TGC) --------------------------------
  // POST /api/v1/ai/assistant — internal employee Q&A grounded on the active
  // Knowledge_Base. Reachable by ADMIN and SALES (assistantGuard). The answer is
  // Gemini-phrased when configured (aiGenerated:true) or a deterministic grounded
  // fallback otherwise (aiGenerated:false) — it never surfaces a 502. Role-based
  // business-data scoping is handled inside the service (Req 7.1–7.3).
  app.post(
    '/api/v1/ai/assistant',
    { preHandler: [auth, assistantGuard] },
    async (request, reply) => {
      const principal = getAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const question = asString(body.question);
      if (!question) {
        // Empty / whitespace-only question after trim -> 400 (Req 6.5).
        throw new ValidationError('question is required', 'AI_QUESTION_REQUIRED');
      }

      const result = await assistant.ask({
        question,
        role: principal.role,
        userId: principal.userId,
      });
      return reply.code(200).send({
        answer: result.answer,
        sources: result.sources,
        aiGenerated: result.aiGenerated,
      });
    },
  );

  // ---- Knowledge base management --------------------------------------------
  app.get(
    '/api/v1/knowledge',
    { preHandler: [auth, kbRead] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const entries = await knowledge.list(asString(q.category), asString(q.market));
      return reply.code(200).send({ entries });
    },
  );

  app.post(
    '/api/v1/knowledge',
    { preHandler: [auth, kbCreate] },
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

      // Best-effort audit (Req 7.1, 7.4): metadata only, never secrets.
      const actor = getAuth(request);
      await oversight?.record({
        actorUserId: actor.userId,
        action: 'KNOWLEDGE_CREATED',
        targetType: 'knowledge_entry',
        targetId: entry.id,
        detail: { category: entry.category, title: entry.title, active: entry.active },
      });

      return reply.code(201).send(entry);
    },
  );

  app.put(
    '/api/v1/knowledge/:id',
    { preHandler: [auth, kbUpdate] },
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

      // A PUT that sets `active:false` is a deactivation; any other write is an
      // update. Audit best-effort with metadata only (Req 7.1, 7.4).
      const deactivated = body.active === false;
      const actor = getAuth(request);
      await oversight?.record({
        actorUserId: actor.userId,
        action: deactivated ? 'KNOWLEDGE_DEACTIVATED' : 'KNOWLEDGE_UPDATED',
        targetType: 'knowledge_entry',
        targetId: entry.id,
        detail: { category: entry.category, title: entry.title, active: entry.active },
      });

      return reply.code(200).send(entry);
    },
  );
}
