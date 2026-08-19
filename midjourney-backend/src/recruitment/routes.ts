/**
 * Recruitment CRM route registration (labor-export / XKLĐ).
 *
 * All routes mount behind the Foundation authentication + RBAC middleware under
 * the existing module 'lead_management' so the established SALES (assigned-only)
 * and ADMIN policies apply without changing the RBAC policy table:
 *   - Candidates   -> module 'lead_management' (ADMIN full; SALES assigned-only
 *                     read/update/status_update; SALES cannot delete).
 *   - Job orders   -> module 'lead_management' (ADMIN full; SALES assigned-only:
 *                     denied create/delete, may read/update only the orders
 *                     assigned to them via jobOrder.assignedTo).
 *
 * For candidate and job-order :id routes the RBAC target resolves ownerUserId
 * from the resource's assignedTo (mirrors leadTargetById in routes/index.ts) so
 * the SALES assigned-only policy is enforced. Uses the /api/v1 gateway prefix.
 *
 * This file does NOT modify existing files; it exports a registrar that the
 * application wires in additively.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { EventBus } from '../infra/events';
import type { OversightService } from '../oversight/oversightService';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
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
import { governanceRoute } from '../governance/middleware';
import {
  maskCandidateResponse,
  maskCandidatesResponse,
  resolveAccessLevel,
} from '../governance/responseMasking';

export interface RecruitmentRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Shared domain event bus; when present, candidate stage events publish. */
  eventBus?: EventBus;
  /** Central oversight emit point; when present, supervised candidate stage
   * changes fan out one ActivityLog + N notifications. */
  oversight?: OversightService;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3). When present it is threaded into the lead_management / job-order /
   * candidate / analytics rbacGuards so each 403 appends one `AUTHZ_DENIED`
   * record. Optional so existing wiring keeps compiling and behaving identically
   * when omitted. */
  auditor?: RbacAuditor;
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
  const candidateService = new CandidateService(prisma, deps.eventBus, deps.oversight);
  const candidateAnalytics = new CandidateAnalyticsService(prisma);
  const auditor = deps.auditor;

  // Collection-level RBAC for the lead_management module.
  const collectionGuard = (action: Action) =>
    rbacGuard(() => ({ module: 'lead_management', action }), auditor);

  // Recruitment analytics is ADMIN-only: guarding on the 'analytics' module
  // (read) means SALES is denied (403) at the preHandler stage before any
  // analytics query runs, while ADMIN remains allowed everywhere.
  const analyticsGuard = rbacGuard(() => ({ module: 'analytics', action: 'read' }), auditor);

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
    }, auditor);

  // For job-order :id routes, resolve ownerUserId from the order's assignedTo
  // so the SALES assigned-only policy is enforced by authorize() (mirrors
  // candidateTargetById). Orders with assignedTo = null resolve to undefined,
  // which never matches a SALES caller (fail-closed).
  const jobOrderTargetById = (action: Action) =>
    rbacGuard(async (request: FastifyRequest) => {
      const { id } = request.params as IdParams;
      const order = await prisma.jobOrder.findUnique({
        where: { id },
        select: { assignedTo: true },
      });
      return {
        module: 'lead_management' as const,
        action,
        ownerUserId: order?.assignedTo ?? undefined,
      };
    }, auditor);

  // ---- Job orders (ADMIN-managed; SALES assigned-only) -----------------------
  // create/delete remain ADMIN-only (collectionGuard); list is collectionGuard
  // with service-layer assigned-only scoping; :id routes resolve ownership via
  // jobOrderTargetById so SALES can only read/update orders assigned to them.
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
        getAuth(request),
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/v1/job-orders/:id',
    { preHandler: [auth, jobOrderTargetById('read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const order = await jobOrderService.get(id, getAuth(request));
      return reply.code(200).send(order);
    },
  );

  app.put(
    '/api/v1/job-orders/:id',
    { preHandler: [auth, jobOrderTargetById('update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const order = await jobOrderService.update(id, (request.body ?? {}) as UpdateJobOrderInput, getAuth(request));
      return reply.code(200).send(order);
    },
  );

  app.post(
    '/api/v1/job-orders/:id/close',
    { preHandler: [auth, jobOrderTargetById('update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const order = await jobOrderService.close(id, getAuth(request));
      return reply.code(200).send(order);
    },
  );

  // ---- Candidates ------------------------------------------------------------
  app.post(
    '/api/v1/candidates',
    { ...governanceRoute({ pii: true, audit: true }), preHandler: [auth, collectionGuard('create')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const body = (request.body ?? {}) as CreateCandidateInput & { allowDuplicate?: unknown };
      const q = (request.query ?? {}) as Record<string, unknown>;
      const allowDuplicate = asBool(body.allowDuplicate) || asBool(q.allowDuplicate);
      const candidate = await candidateService.create(body, actor, { allowDuplicate });
      const level = resolveAccessLevel(actor.role);
      return reply.code(201).send(maskCandidateResponse(candidate as Record<string, unknown>, level));
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
      const level = resolveAccessLevel(actor.role);
      const safeResult = {
        ...result,
        items: maskCandidatesResponse((result.items ?? []) as Record<string, unknown>[], level),
      };
      return reply.code(200).send(safeResult);
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

  // Candidate-level conversion analytics (ADMIN-only; SALES -> 403). Guarded on
  // the 'analytics' module so the deny happens at the preHandler stage before
  // any analytics query runs.
  app.get(
    '/api/v1/candidates/analytics/funnel',
    { preHandler: [auth, analyticsGuard] },
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
    { preHandler: [auth, analyticsGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const buckets = await candidateAnalytics.byMarket(asString(q.from), asString(q.to), actor);
      return reply.code(200).send({ groupBy: 'desiredMarket', buckets });
    },
  );

  app.get(
    '/api/v1/candidates/analytics/by-source',
    { preHandler: [auth, analyticsGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const buckets = await candidateAnalytics.bySource(asString(q.from), asString(q.to), actor);
      return reply.code(200).send({ groupBy: 'source', buckets });
    },
  );

  app.get(
    '/api/v1/candidates/analytics/conversion-by-job-order',
    { preHandler: [auth, analyticsGuard] },
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
    { ...governanceRoute({ audit: true }), preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const candidate = await candidateService.get(id, actor);
      const level = resolveAccessLevel(actor.role);
      return reply.code(200).send(maskCandidateResponse(candidate as Record<string, unknown>, level));
    },
  );

  app.put(
    '/api/v1/candidates/:id',
    { ...governanceRoute({ pii: true, audit: true }), preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const candidate = await candidateService.update(
        id,
        (request.body ?? {}) as UpdateCandidateInput,
        actor,
      );
      const level = resolveAccessLevel(actor.role);
      return reply.code(200).send(maskCandidateResponse(candidate as Record<string, unknown>, level));
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
    { ...governanceRoute({ audit: true, auditAction: 'DATA_DELETE' }), preHandler: [auth, candidateTargetById('delete')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      await candidateService.delete(id, actor);
      return reply.code(200).send({ status: 'ok' });
    },
  );
}
