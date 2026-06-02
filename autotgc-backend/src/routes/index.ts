/**
 * HTTP route registration: health, auth, leads (CRUD + stats), webhooks, dashboard.
 * Pure domain logic lives in services; this layer handles request/response shaping,
 * auth/rbac wiring, raw-body HMAC for webhooks, and Prisma-backed dashboard aggregation.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../infra/config';
import type { JwtService } from '../auth/jwt';
import { AuthService } from '../auth/authService';
import { LeadService } from '../leads/leadService';
import type { UpdateLeadInput } from '../leads/leadService';
import { NoteAnalysisService } from '../leads/noteAnalysisService';
import { ScheduleBoardService } from '../content/scheduleBoardService';
import { ApprovalQueueService } from '../recruitment/approvalQueueService';
import type { ReorderRequest } from '../content/reorder';
import {
  resolveFacebookAttribution,
  resolveWebsiteAttribution,
} from '../leads/validation';
import type { Attribution, CreateLeadInput } from '../leads/validation';
import { verifySignature } from '../infra/hmac';
import { isDataStale, isUpcoming } from '../dashboard/helpers';
import { buildApprovalQueue } from '../dashboard/assembler';
import { composeOverview, safeRate } from '../dashboard/adminOverview';
import type {
  ActivityFeedItem,
  CompanyKpis,
  PersonalKpis,
} from '../dashboard/adminOverview';
import { ActivityLogger } from '../oversight/activityLogger';
import type { OversightService } from '../oversight/oversightService';
import {
  UnauthorizedError,
  ValidationError,
} from '../infra/errors';
import {
  getAuth,
  rbacGuard,
  requireAuth,
} from '../http/authMiddleware';
import type { AuthInfo } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import { AUTH_RATE_LIMIT } from '../http/security';
import type { EventBus } from '../infra/events';

export interface RouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  config: AppConfig;
  /** Shared domain event bus; when present, lead events are published. */
  eventBus?: EventBus;
  /** Central oversight emit point; when present, supervised lead status
   * changes (QUALIFIED/CONVERTED) fan out one ActivityLog + N notifications. */
  oversight?: OversightService;
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

/** Parse an ISO date string into a Date, or undefined when absent/invalid. */
function parseDate(value: unknown): Date | undefined {
  const s = asString(value);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Parse a drag-and-drop `Reorder_Request` body: `{ orderedIds: string[] }`. A
 * missing/non-array `orderedIds` or any non-string entry is rejected with 400 so
 * the pure reorder helpers always receive a well-formed string[] (Req 9.2, 10.1).
 */
function parseReorderRequest(body: unknown): ReorderRequest {
  const raw = (body ?? {}) as Record<string, unknown>;
  const ids = raw.orderedIds;
  if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === 'string')) {
    throw new ValidationError('orderedIds must be an array of strings', 'REORDER_IDS_INVALID');
  }
  return { orderedIds: ids };
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { prisma, jwt, config } = deps;
  const authService = new AuthService(
    prisma,
    jwt,
    config.lockoutThreshold,
    config.accessTokenTtlHours,
    config.refreshTokenTtlDays,
  );
  const leadService = new LeadService(prisma, deps.eventBus, deps.oversight);
  const noteAnalysisService = new NoteAnalysisService(prisma);
  const scheduleBoardService = new ScheduleBoardService(prisma);
  const approvalQueueService = new ApprovalQueueService(prisma);
  const auth = requireAuth({ prisma, jwt });

  // ---- Health ----------------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok' }));

  // ---- Auth ------------------------------------------------------------------
  app.post('/api/auth/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const result = await authService.register((request.body ?? {}) as Record<string, string>);
    return reply.code(201).send(result);
  });

  app.post('/api/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string };
    const result = await authService.login(body.username, body.password);
    return reply.code(200).send(result);
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    if (!body.refreshToken) {
      throw new ValidationError('refreshToken is required', 'MISSING_REFRESH_TOKEN');
    }
    const result = await authService.refresh(body.refreshToken);
    return reply.code(200).send(result);
  });

  app.post('/api/auth/logout', { preHandler: auth }, async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    await authService.logout(token);
    return reply.code(200).send({ status: 'ok' });
  });

  // ---- Leads -----------------------------------------------------------------
  const leadTargetCollection = (action: Action) =>
    rbacGuard(() => ({ module: 'lead_management', action }));

  // For :id routes, resolve ownerUserId from the lead's assignedTo so SALES
  // assigned-only policy can be enforced by authorize().
  const leadTargetById = (action: Action) =>
    rbacGuard(async (request: FastifyRequest) => {
      const { id } = request.params as IdParams;
      const lead = await prisma.lead.findUnique({
        where: { leadId: id },
        select: { assignedTo: true },
      });
      return {
        module: 'lead_management' as const,
        action,
        ownerUserId: lead?.assignedTo ?? undefined,
      };
    });

  app.post(
    '/api/leads',
    { preHandler: [auth, leadTargetCollection('create')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const lead = await leadService.create((request.body ?? {}) as CreateLeadInput, actor);
      return reply.code(201).send(lead);
    },
  );

  app.get(
    '/api/leads',
    { preHandler: [auth, leadTargetCollection('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await leadService.list(
        {
          source: asString(q.source),
          platform: asString(q.platform),
          status: asString(q.status),
          from: asString(q.from),
          to: asString(q.to),
        },
        asInt(q.page, 1),
        asInt(q.limit, 20),
        actor,
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/leads/stats',
    { preHandler: [auth, leadTargetCollection('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await leadService.stats(
        asString(q.groupBy) ?? 'source',
        asString(q.from),
        asString(q.to),
        actor,
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/leads/export',
    { preHandler: [auth, leadTargetCollection('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const q = (request.query ?? {}) as Record<string, unknown>;
      const file = await leadService.export(
        asString(q.format) ?? 'csv',
        asString(q.from),
        asString(q.to),
        actor,
      );
      return reply
        .code(200)
        .header('content-type', file.contentType)
        .header('content-disposition', `attachment; filename="${file.filename}"`)
        .send(file.body);
    },
  );

  app.get(
    '/api/leads/:id',
    { preHandler: [auth, leadTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const lead = await leadService.get(id, actor);
      return reply.code(200).send(lead);
    },
  );

  // Note intent analysis (proposal 3.3): a read-only "độ nóng" score + suggested
  // next status derived from the lead's notes. SALES is assigned-only (resolved
  // by leadTargetById); the service also re-checks scoping defensively.
  app.get(
    '/api/leads/:id/intent',
    { preHandler: [auth, leadTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const signal = await noteAnalysisService.analyzeLead(id, actor);
      return reply.code(200).send({ leadId: id, ...signal });
    },
  );

  app.put(
    '/api/leads/:id',
    { preHandler: [auth, leadTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const lead = await leadService.update(id, (request.body ?? {}) as UpdateLeadInput, actor);
      return reply.code(200).send(lead);
    },
  );

  app.delete(
    '/api/leads/:id',
    { preHandler: [auth, leadTargetById('delete')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      await leadService.delete(id, actor);
      return reply.code(200).send({ status: 'ok' });
    },
  );

  // ---- Webhooks (raw body + HMAC, encapsulated parser scope) ------------------
  await app.register(async (scope) => {
    // Capture the raw request body as a Buffer (no JSON parsing) so we can verify
    // the HMAC signature before trusting/parsing any content.
    const rawParser = (
      _req: FastifyRequest,
      body: Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ) => done(null, body);
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawParser);
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, rawParser);

    const handleWebhook = (
      platform: 'facebook' | 'website',
    ) => async (request: FastifyRequest, reply: FastifyReply) => {
      const raw: Buffer = Buffer.isBuffer(request.body)
        ? (request.body as Buffer)
        : Buffer.from(typeof request.body === 'string' ? request.body : '', 'utf8');

      const secret =
        platform === 'facebook' ? config.webhookSecrets.facebook : config.webhookSecrets.website;
      const signature =
        (request.headers['x-hub-signature-256'] as string | undefined) ??
        (request.headers['x-signature'] as string | undefined) ??
        '';

      // 401 on bad signature BEFORE parsing the payload.
      if (!verifySignature(secret, raw, signature)) {
        throw new UnauthorizedError('Invalid webhook signature', 'INVALID_SIGNATURE');
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new ValidationError('Webhook payload is not valid JSON', 'INVALID_JSON');
      }

      const contentPostId =
        asString(payload.contentPostId) ?? asString(payload.content_post_id);
      const utmSource = asString(payload.utmSource) ?? asString(payload.utm_source);

      const attribution: Attribution =
        platform === 'facebook'
          ? resolveFacebookAttribution(contentPostId)
          : resolveWebsiteAttribution(utmSource, contentPostId);

      const fields: CreateLeadInput = {
        name: asString(payload.name) ?? null,
        phone: asString(payload.phone) ?? null,
        email: asString(payload.email) ?? null,
        utmSource: utmSource ?? null,
        utmMedium: asString(payload.utmMedium) ?? asString(payload.utm_medium) ?? null,
        utmCampaign: asString(payload.utmCampaign) ?? asString(payload.utm_campaign) ?? null,
        domainCategory: asString(payload.domainCategory) ?? asString(payload.domain_category) ?? null,
        contentTopic: asString(payload.contentTopic) ?? asString(payload.content_topic) ?? null,
      };

      const lead = await leadService.createFromWebhook(attribution, fields);
      return reply.code(201).send(lead);
    };

    scope.post('/api/leads/webhook/facebook', handleWebhook('facebook'));
    scope.post('/api/leads/webhook/website', handleWebhook('website'));
  });

  // ---- Dashboard -------------------------------------------------------------
  const dashboardGuard = rbacGuard(() => ({ module: 'dashboard', action: 'read' }));

  app.get(
    '/api/dashboard/overview',
    { preHandler: [auth, dashboardGuard] },
    async (request, reply) => {
      const overview = await buildDashboardOverview(prisma, config, getAuth(request));
      return reply.code(200).send(overview);
    },
  );

  app.get(
    '/api/dashboard/notifications',
    { preHandler: [auth, dashboardGuard] },
    async (request, reply) => {
      const notifications = await buildDashboardNotifications(prisma, getAuth(request));
      return reply.code(200).send({ notifications });
    },
  );

  // ---- Drag-and-drop: Schedule_Board + Approval_Queue ------------------------
  // All behind requireAuth + rbacGuard. Schedule_Board reorder/reschedule map to
  // module 'strategy'/update, Approval_Queue reorder maps to 'feedback'/update —
  // so ADMIN may write and SALES is denied with 403 (Req 9.7, 10.1). Body
  // validation parses dates / orderedIds; bad input -> ValidationError (400).
  const strategyUpdateGuard = rbacGuard(() => ({ module: 'strategy', action: 'update' }));
  const feedbackUpdateGuard = rbacGuard(() => ({ module: 'feedback', action: 'update' }));

  // Reorder a plan's ContentPlanItems from a drag-and-drop gesture (Req 9.2, 9.3, 9.7).
  app.post(
    '/api/v1/content-plans/:planId/reorder',
    { preHandler: [auth, strategyUpdateGuard] },
    async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const req = parseReorderRequest(request.body);
      const items = await scheduleBoardService.reorderItems(planId, req);
      return reply.code(200).send({ items });
    },
  );

  // Reschedule a single ContentPlanItem to a new target date (Req 9.1).
  app.put(
    '/api/v1/content-plan-items/:id/reschedule',
    { preHandler: [auth, strategyUpdateGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const targetDate = parseDate(body.targetDate);
      if (!targetDate) {
        throw new ValidationError('targetDate is required', 'RESCHEDULE_TARGET_REQUIRED');
      }
      const item = await scheduleBoardService.rescheduleItem(id, targetDate);
      return reply.code(200).send(item);
    },
  );

  // Reorder the Approval_Queue (DRAFT drafts ∪ PENDING_REVIEW insights) (Req 10.1).
  app.post(
    '/api/v1/approval-queue/reorder',
    { preHandler: [auth, feedbackUpdateGuard] },
    async (request, reply) => {
      const req = parseReorderRequest(request.body);
      const items = await approvalQueueService.reorder(req);
      return reply.code(200).send({ items });
    },
  );
}

// ---- Dashboard aggregation helpers ------------------------------------------

async function buildDashboardOverview(
  prisma: PrismaClient,
  config: AppConfig,
  actor: AuthInfo,
) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 86400 * 1000);

  // Role-branched overview (Req 3.6, 6.1–6.5): ADMIN gets a company-wide payload
  // with a Recent_Activity_Feed; SALES gets a personal, assigned-only payload
  // with NO feed and NO company stats. The scope decision + divide-by-zero-safe
  // rate live in the pure `composeOverview`/`safeRate` helpers; this layer only
  // reads the data and hands it over. The Approval_Queue, upcoming-publishing
  // schedule and failed-post / token alerts remain ADMIN operational content
  // (Generation/Feedback/Publishing) and are preserved alongside the company
  // payload to minimize breakage for existing consumers.
  const isAdmin = actor.role === 'ADMIN';

  // SALES KPIs are scoped to assigned leads (Req 3.5); ADMIN is company-wide.
  const leadWhere = actor.role === 'SALES' ? { assignedTo: actor.userId } : {};

  // Lead KPIs (role-scoped) are visible to BOTH roles; the data-sync freshness
  // banner is harmless metadata. Everything else is ADMIN-only and is fetched
  // only for ADMIN so no Generation/Feedback/Publishing data reaches SALES.
  const [totalLeads, leadsByStatusRaw, latestAnalytics] = await Promise.all([
    prisma.lead.count({ where: leadWhere }),
    prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } }),
    prisma.analyticsRecord.findFirst({ orderBy: { collectedAt: 'desc' } }),
  ]);

  const lastSync = latestAnalytics?.collectedAt ?? null;
  const stale = isDataStale(lastSync, now, config.syncStalenessHours);

  const leadsByStatus: Record<string, number> = {};
  for (const row of leadsByStatusRaw as Array<{ status: string; _count: { _all: number } }>) {
    leadsByStatus[row.status] = row._count._all;
  }

  const dataSync = {
    lastSync,
    stale,
    status: stale ? 'STALE' : 'CURRENT',
    thresholdHours: config.syncStalenessHours,
  };

  // SALES: a lead-only, read-only dashboard scoped to assigned leads. The
  // Approval_Queue, upcoming publishing schedule, failure/token alerts AND the
  // company-wide Recent_Activity_Feed are intentionally omitted so no admin
  // operational content or company stats leak to a consultant account
  // (Req 3.4, 6.3, 6.4). The `company` argument is discarded by composeOverview
  // for SALES, so we never compute company-wide data for this branch.
  if (!isAdmin) {
    const personalKpis: PersonalKpis = { totalLeads, leadsByStatus };
    const emptyCompany: { kpis: CompanyKpis; recentActivity: ActivityFeedItem[] } = {
      kpis: {
        totalLeads: 0,
        candidateFunnel: {},
        pendingApprovals: 0,
        conversionRate: 'INSUFFICIENT_DATA',
      },
      recentActivity: [],
    };
    const salesPayload = composeOverview(actor.role, emptyCompany, { kpis: personalKpis });
    return {
      ...salesPayload,
      dataSync,
    };
  }

  const [
    draftCount,
    pendingInsightCount,
    scheduledPosts,
    failedPosts,
    queueDrafts,
    queueInsights,
  ] = await Promise.all([
    prisma.contentDraft.count({ where: { status: 'DRAFT' } }),
    prisma.learningInsight.count({ where: { insightStatus: 'PENDING_REVIEW' } }),
    prisma.scheduledPost.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: now, lte: horizon } },
      orderBy: { scheduledAt: 'asc' },
    }),
    prisma.scheduledPost.findMany({
      where: { status: 'FAILED' },
      orderBy: { updatedAt: 'desc' },
    }),
    // Approval_Queue membership for the drag-and-drop UX (Req 10.1, 10.3): the
    // DRAFT drafts and PENDING_REVIEW insights with their persisted priorityIndex.
    prisma.contentDraft.findMany({
      where: { status: 'DRAFT' },
      select: { id: true, title: true, status: true, priorityIndex: true, createdAt: true },
    }),
    prisma.learningInsight.findMany({
      where: { insightStatus: 'PENDING_REVIEW' },
      select: { id: true, insightStatus: true, insightType: true, priorityIndex: true, generatedAt: true },
    }),
  ]);

  // Compose the ordered Approval_Queue items via the pure assembler so the
  // rendered order matches the persisted priorityIndex (ascending) — Req 10.3.
  const approvalQueueItems = buildApprovalQueue(
    queueDrafts.map((d) => ({
      id: d.id,
      status: 'DRAFT' as const,
      title: d.title,
      createdAt: d.createdAt.toISOString(),
      priorityIndex: d.priorityIndex,
    })),
    queueInsights.map((i) => ({
      id: i.id,
      insightStatus: 'PENDING_REVIEW' as const,
      title: i.insightType,
      createdAt: i.generatedAt.toISOString(),
      priorityIndex: i.priorityIndex,
    })),
  ).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    priorityIndex: item.priorityIndex,
  }));

  const upcomingPosts = scheduledPosts.filter((p) => isUpcoming(p.scheduledAt, now));

  // Company-wide candidate funnel by CandidateStage (Req 6.1). Loaded
  // best-effort: a funnel read failure must not break the operational overview,
  // mirroring the oversight error-isolation principle (auxiliary read).
  let candidateFunnel: Record<string, number> = {};
  try {
    const funnelRows = await prisma.candidateProfile.groupBy({
      by: ['stage'],
      _count: { _all: true },
    });
    for (const row of funnelRows as Array<{ stage: string; _count: { _all: number } }>) {
      candidateFunnel[row.stage] = row._count._all;
    }
  } catch {
    candidateFunnel = {};
  }

  // Recent_Activity_Feed from the append-only ActivityLog, newest first (Req 6.2,
  // 6.5, 6.6). createdAt is serialized to an ISO string for the feed item.
  // Loaded best-effort so a feed read failure degrades to an empty feed rather
  // than failing the dashboard.
  let recentActivity: ActivityFeedItem[] = [];
  try {
    const activityLogger = new ActivityLogger(prisma);
    const { items } = await activityLogger.listRecent(1, 20);
    recentActivity = items.map((entry) => ({
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      createdAt: entry.createdAt.toISOString(),
    }));
  } catch {
    recentActivity = [];
  }

  // Company KPIs (Req 6.1): company-wide lead total, candidate funnel, pending
  // approvals (existing DRAFT drafts + PENDING_REVIEW insights), and a
  // divide-by-zero-safe conversion rate (Req 6.7).
  const convertedLeads = leadsByStatus.CONVERTED ?? 0;
  const companyKpis: CompanyKpis = {
    totalLeads,
    candidateFunnel,
    pendingApprovals: draftCount + pendingInsightCount,
    conversionRate: safeRate(convertedLeads, totalLeads),
  };

  // The personal payload is discarded by composeOverview for ADMIN, but a
  // well-typed value is still required by the pure helper's signature.
  const personalKpis: PersonalKpis = { totalLeads, leadsByStatus };

  const overview = composeOverview(
    actor.role,
    { kpis: companyKpis, recentActivity },
    { kpis: personalKpis },
  );

  // Preserve the existing ADMIN operational sections (Approval_Queue, upcoming
  // publishing schedule, failure/token alerts, data-sync banner) alongside the
  // role-branched company payload to minimize breakage for existing consumers.
  return {
    ...overview,
    approvalQueue: {
      draftCount,
      pendingInsightCount,
      total: draftCount + pendingInsightCount,
      items: approvalQueueItems,
    },
    upcomingPosts: upcomingPosts.map((p) => ({
      id: p.id,
      platform: p.platform,
      scheduledAt: p.scheduledAt,
      status: p.status,
    })),
    alerts: {
      failedPosts: failedPosts.map((p) => ({
        id: p.id,
        platform: p.platform,
        errorCode: p.errorCode,
        failureReason: p.failureReason,
        retryCount: p.retryCount,
      })),
    },
    dataSync,
  };
}

async function buildDashboardNotifications(prisma: PrismaClient, actor: AuthInfo) {
  // Every notification kind here (failed posts, pending AI insights, upcoming
  // scheduled posts) is ADMIN operational content from the Publishing / Feedback
  // modules. SALES has no access to those modules, so a SALES principal receives
  // an empty notification feed rather than admin task content.
  if (actor.role !== 'ADMIN') {
    return [] as Array<{ type: string; refId: string; message: string; at: Date }>;
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 86400 * 1000);

  const [failedPosts, pendingInsights, scheduledPosts] = await Promise.all([
    prisma.scheduledPost.findMany({ where: { status: 'FAILED' }, orderBy: { updatedAt: 'desc' } }),
    prisma.learningInsight.findMany({
      where: { insightStatus: 'PENDING_REVIEW' },
      orderBy: { generatedAt: 'desc' },
    }),
    prisma.scheduledPost.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: now, lte: horizon } },
      orderBy: { scheduledAt: 'asc' },
    }),
  ]);

  const notifications: Array<{ type: string; refId: string; message: string; at: Date }> = [];

  for (const p of failedPosts) {
    notifications.push({
      type: 'error',
      refId: p.id,
      message: `Post ${p.id} failed on ${p.platform}: ${p.failureReason ?? p.errorCode ?? 'unknown error'}`,
      at: p.updatedAt,
    });
  }
  for (const insight of pendingInsights) {
    notifications.push({
      type: 'review',
      refId: insight.id,
      message: `Insight ${insight.id} is pending review`,
      at: insight.generatedAt,
    });
  }
  for (const p of scheduledPosts.filter((s) => isUpcoming(s.scheduledAt, now))) {
    notifications.push({
      type: 'info',
      refId: p.id,
      message: `Post ${p.id} scheduled on ${p.platform}`,
      at: p.scheduledAt,
    });
  }

  return notifications;
}
