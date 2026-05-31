/**
 * Recruitment CRM route registration (labor-export / XKLĐ).
 *
 * All routes mount behind the Foundation authentication + RBAC middleware under
 * the existing module 'lead_management' so the established SALES (assigned-only)
 * and ADMIN policies apply without changing the RBAC policy table:
 *   - Candidates   -> module 'lead_management' (ADMIN full; SALES assigned-only
 *                     read/update/status_update; SALES cannot delete).
 *   - Job orders   -> module 'lead_management' create/update/delete (ADMIN-managed;
 *                     SALES is denied create/delete but may read).
 *
 * For candidate :id routes the RBAC target resolves ownerUserId from the
 * candidate's assignedTo (mirrors leadTargetById in routes/index.ts) so the
 * SALES assigned-only policy is enforced. Uses the /api/v1 gateway prefix.
 *
 * This file does NOT modify existing files; it exports a registrar that the
 * application wires in additively.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { EventBus } from '../infra/events';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import { ValidationError } from '../infra/errors';
import { JobOrderService } from './jobOrderService';
import type { CreateJobOrderInput, UpdateJobOrderInput } from './jobOrderService';
import { CandidateService } from './candidateService';
import type {
  CreateCandidateInput,
  PromoteFromLeadExtra,
  UpdateCandidateInput,
} from './candidateService';
import { CandidateAnalyticsService } from './candidateAnalytics';

export interface RecruitmentRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Shared domain event bus; when present, candidate stage events publish. */
  eventBus?: EventBus;
}

interface IdParams {
  id: string;
}

interface LeadIdParams {
  leadId: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === '1';
}

export async function registerRecruitmentRoutes(
  app: FastifyInstance,
  deps: RecruitmentRouteDeps,
): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const jobOrderService = new JobOrderService(prisma);
  const candidateService = new CandidateService(prisma, deps.eventBus);
  const candidateAnalytics = new CandidateAnalyticsService(prisma);

  // Collection-level RBAC for the lead_management module.
  const collectionGuard = (action: Action) =>
    rbacGuard(() => ({ module: 'lead_management', action }));

  // For candidate :id routes, resolve ownerUserId from the candidate's
  // assignedTo so the SALES assigned-only policy can be enforced by authorize().
  const candidateTargetById = (action: Action) =>
    rbacGuard(async (request: FastifyRequest) => {
      const { id } = request.params as IdParams;
      const candidate = await prisma.candidateProfile.findUnique({
        where: { id },
        select: { assignedTo: true },
      });
      return {
        module: 'lead_management' as const,
        action,
        ownerUserId: candidate?.assignedTo ?? undefined,
      };
    });

  // ---- Job orders (ADMIN-managed; SALES read-only) ---------------------------
  app.post(
    '/api/v1/job-orders',
    { preHandler: [auth, collectionGuard('create')] },
    async (request, reply) => {
      const order = await jobOrderService.create((request.body ?? {}) as CreateJobOrderInput);
      return reply.code(201).send(order);
    },
  );

  app.get(
    '/api/v1/job-orders',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await jobOrderService.list(
        {
          market: asString(q.market),
          visaType: asString(q.visaType),
          industry: asString(q.industry),
          status: asString(q.status),
        },
        asInt(q.page, 1),
        asInt(q.limit, 20),
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/v1/job-orders/:id',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const order = await jobOrderService.get(id);
      return reply.code(200).send(order);
    },
  );

  app.put(
    '/api/v1/job-orders/:id',
    { preHandler: [auth, collectionGuard('update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const order = await jobOrderService.update(id, (request.body ?? {}) as UpdateJobOrderInput);
      return reply.code(200).send(order);
    },
  );

  app.post(
    '/api/v1/job-orders/:id/close',
    { preHandler: [auth, collectionGuard('update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const order = await jobOrderService.close(id);
      return reply.code(200).send(order);
    },
  );

  // ---- Candidates ------------------------------------------------------------
  app.post(
    '/api/v1/candidates',
    { preHandler: [auth, collectionGuard('create')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const body = (request.body ?? {}) as CreateCandidateInput & { allowDuplicate?: unknown };
      const q = (request.query ?? {}) as Record<string, unknown>;
      const allowDuplicate = asBool(body.allowDuplicate) || asBool(q.allowDuplicate);
      const candidate = await candidateService.create(body, actor, { allowDuplicate });
      return reply.code(201).send(candidate);
    },
  );

  app.get(
    '/api/v1/candidates',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await candidateService.list(
        {
          stage: asString(q.stage),
          desiredMarket: asString(q.desiredMarket),
          assignedTo: asString(q.assignedTo),
          branchId: asString(q.branchId),
        },
        asInt(q.page, 1),
        asInt(q.limit, 20),
        actor,
      );
      return reply.code(200).send(result);
    },
  );

  // Static routes registered before '/:id' so they take precedence.
  app.get(
    '/api/v1/candidates/stats',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await candidateService.stats(asString(q.groupBy) ?? 'stage', actor);
      return reply.code(200).send(result);
    },
  );

  // Candidate search (paginated). Registered before '/:id' for precedence.
  app.get(
    '/api/v1/candidates/search',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await candidateService.search(
        {
          q: asString(q.q),
          stage: asString(q.stage),
          stageIn: asString(q.stageIn),
          desiredMarket: asString(q.desiredMarket),
          desiredVisaType: asString(q.desiredVisaType),
          japaneseLevel: asString(q.japaneseLevel),
          assignedTo: asString(q.assignedTo),
          branchId: asString(q.branchId),
        },
        asInt(q.page, 1),
        asInt(q.limit, 20),
        actor,
      );
      return reply.code(200).send(result);
    },
  );

  // Candidate-level conversion analytics (read; SALES assigned-only scoping).
  app.get(
    '/api/v1/candidates/analytics/funnel',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await candidateAnalytics.funnel(
        {
          from: asString(q.from),
          to: asString(q.to),
          market: asString(q.market) ?? asString(q.desiredMarket),
          assignedTo: asString(q.assignedTo),
        },
        actor,
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/v1/candidates/analytics/by-market',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const buckets = await candidateAnalytics.byMarket(asString(q.from), asString(q.to), actor);
      return reply.code(200).send({ groupBy: 'desiredMarket', buckets });
    },
  );

  app.get(
    '/api/v1/candidates/analytics/by-source',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const buckets = await candidateAnalytics.bySource(asString(q.from), asString(q.to), actor);
      return reply.code(200).send({ groupBy: 'source', buckets });
    },
  );

  app.get(
    '/api/v1/candidates/analytics/conversion-by-job-order',
    { preHandler: [auth, collectionGuard('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const buckets = await candidateAnalytics.conversionByJobOrder(
        asString(q.from),
        asString(q.to),
        actor,
      );
      return reply.code(200).send({ buckets });
    },
  );

  app.post(
    '/api/v1/candidates/from-lead/:leadId',
    { preHandler: [auth, collectionGuard('create')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { leadId } = request.params as LeadIdParams;
      const candidate = await candidateService.promoteFromLead(
        leadId,
        (request.body ?? {}) as PromoteFromLeadExtra,
        actor,
      );
      return reply.code(201).send(candidate);
    },
  );

  app.get(
    '/api/v1/candidates/:id',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const candidate = await candidateService.get(id, actor);
      return reply.code(200).send(candidate);
    },
  );

  app.put(
    '/api/v1/candidates/:id',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const candidate = await candidateService.update(
        id,
        (request.body ?? {}) as UpdateCandidateInput,
        actor,
      );
      return reply.code(200).send(candidate);
    },
  );

  app.post(
    '/api/v1/candidates/:id/match',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const jobOrderId = asString(body.jobOrderId);
      if (!jobOrderId) {
        throw new ValidationError('jobOrderId is required', 'JOB_ORDER_ID_REQUIRED');
      }
      const candidate = await candidateService.matchToJobOrder(id, jobOrderId, actor);
      return reply.code(200).send(candidate);
    },
  );

  app.delete(
    '/api/v1/candidates/:id',
    { preHandler: [auth, candidateTargetById('delete')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      await candidateService.delete(id, actor);
      return reply.code(200).send({ status: 'ok' });
    },
  );
}
