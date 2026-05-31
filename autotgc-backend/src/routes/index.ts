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
import {
  resolveFacebookAttribution,
  resolveWebsiteAttribution,
} from '../leads/validation';
import type { Attribution, CreateLeadInput } from '../leads/validation';
import { verifySignature } from '../infra/hmac';
import { isDataStale, isUpcoming } from '../dashboard/helpers';
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

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { prisma, jwt, config } = deps;
  const authService = new AuthService(
    prisma,
    jwt,
    config.lockoutThreshold,
    config.accessTokenTtlHours,
    config.refreshTokenTtlDays,
  );
  const leadService = new LeadService(prisma, deps.eventBus);
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
    async (_request, reply) => {
      const notifications = await buildDashboardNotifications(prisma);
      return reply.code(200).send({ notifications });
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

  // SALES KPIs are scoped to assigned leads.
  const leadWhere = actor.role === 'SALES' ? { assignedTo: actor.userId } : {};

  const [
    draftCount,
    pendingInsightCount,
    scheduledPosts,
    failedPosts,
    totalLeads,
    leadsByStatusRaw,
    latestAnalytics,
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
    prisma.lead.count({ where: leadWhere }),
    prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } }),
    prisma.analyticsRecord.findFirst({ orderBy: { collectedAt: 'desc' } }),
  ]);

  const upcomingPosts = scheduledPosts.filter((p) => isUpcoming(p.scheduledAt, now));
  const lastSync = latestAnalytics?.collectedAt ?? null;
  const stale = isDataStale(lastSync, now, config.syncStalenessHours);

  const leadsByStatus: Record<string, number> = {};
  for (const row of leadsByStatusRaw as Array<{ status: string; _count: { _all: number } }>) {
    leadsByStatus[row.status] = row._count._all;
  }

  return {
    approvalQueue: {
      draftCount,
      pendingInsightCount,
      total: draftCount + pendingInsightCount,
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
    kpis: {
      totalLeads,
      leadsByStatus,
    },
    dataSync: {
      lastSync,
      stale,
      status: stale ? 'STALE' : 'CURRENT',
      thresholdHours: config.syncStalenessHours,
    },
  };
}

async function buildDashboardNotifications(prisma: PrismaClient) {
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
