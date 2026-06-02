/**
 * Regression: SALES (consultant) must NOT see ADMIN operational content on the
 * read-only dashboard.
 *
 * Per LoginRegister.md RBAC (Phase 1): SALES = Lead Management + read-only
 * Dashboard, and explicitly NO Strategy/Generation/Publishing/Settings. The
 * dashboard guard maps to `dashboard/read`, which the pure RBAC policy grants to
 * BOTH roles — so the data scoping that keeps Generation/Feedback/Publishing
 * content away from SALES lives in the overview/notifications assemblers. These
 * tests lock that scoping in:
 *
 *   - GET /api/dashboard/overview      → ADMIN sees approvalQueue/upcomingPosts/
 *                                        alerts; SALES sees ONLY lead-scoped
 *                                        kpis + dataSync (no admin sections).
 *   - GET /api/dashboard/notifications → ADMIN gets failure/insight/upcoming
 *                                        notifications; SALES gets an empty feed.
 *
 * Mirrors the FastifyInstance-double pattern from `reportingRoutes.test.ts`: a
 * minimal Fastify double captures the registered handlers so we invoke their
 * bodies directly (the requireAuth/rbacGuard preHandlers are out of scope; the
 * scoping under test is inside the route handlers' assemblers).
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { registerRoutes } from '../src/routes';
import type { AppConfig } from '../src/infra/config';
import type { JwtService } from '../src/auth/jwt';

const NOW = new Date('2025-06-09T00:00:00.000Z');
const SOON = new Date(NOW.getTime() + 2 * 86400 * 1000);

const ADMIN = { userId: 'admin-1', role: 'ADMIN' as const, sessionId: 's-admin' };
const SALES = { userId: 'sales-1', role: 'SALES' as const, sessionId: 's-sales' };

interface LeadRow {
  status: string;
  assignedTo: string | null;
  createdAt: Date;
}

/**
 * In-memory Prisma fake covering exactly the reads the dashboard assemblers
 * perform. Lead KPIs honor the `assignedTo` scope so SALES sees only its own
 * leads; the admin-only tables are seeded so a leak would be observable.
 */
function makePrismaFake(): PrismaClient {
  const leads: LeadRow[] = [
    { status: 'NEW', assignedTo: 'sales-1', createdAt: NOW },
    { status: 'CONTACTED', assignedTo: 'sales-1', createdAt: NOW },
    { status: 'NEW', assignedTo: 'someone-else', createdAt: NOW },
    { status: 'WON', assignedTo: null, createdAt: NOW },
  ];

  const matchLead = (row: LeadRow, where: { assignedTo?: string } | undefined): boolean =>
    !where?.assignedTo || row.assignedTo === where.assignedTo;

  return {
    lead: {
      count: async (args?: { where?: { assignedTo?: string } }) =>
        leads.filter((l) => matchLead(l, args?.where)).length,
      groupBy: async (args: { where?: { assignedTo?: string } }) => {
        const counts = new Map<string, number>();
        for (const l of leads.filter((x) => matchLead(x, args.where))) {
          counts.set(l.status, (counts.get(l.status) ?? 0) + 1);
        }
        return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
      },
    },
    analyticsRecord: {
      findFirst: async () => ({ collectedAt: NOW }),
    },
    contentDraft: {
      count: async () => 2,
      findMany: async () => [
        { id: 'd1', title: 'Secret campaign draft', status: 'DRAFT', priorityIndex: 0, createdAt: NOW },
        { id: 'd2', title: 'Q3 launch draft', status: 'DRAFT', priorityIndex: 1, createdAt: NOW },
      ],
    },
    learningInsight: {
      count: async () => 1,
      findMany: async () => [
        {
          id: 'i1',
          insightStatus: 'PENDING_REVIEW',
          insightType: 'TONE_ADJUSTMENT',
          priorityIndex: 0,
          generatedAt: NOW,
        },
      ],
    },
    scheduledPost: {
      findMany: async (args: { where?: { status?: string } }) => {
        if (args.where?.status === 'FAILED') {
          return [
            {
              id: 'p-failed',
              platform: 'facebook',
              status: 'FAILED',
              errorCode: 'TOKEN_EXPIRED',
              failureReason: 'token expired',
              retryCount: 1,
              scheduledAt: NOW,
              updatedAt: NOW,
            },
          ];
        }
        return [
          {
            id: 'p-upcoming',
            platform: 'tiktok',
            status: 'SCHEDULED',
            scheduledAt: SOON,
            updatedAt: NOW,
          },
        ];
      },
    },
  } as unknown as PrismaClient;
}

const CONFIG = { syncStalenessHours: 6 } as unknown as AppConfig;

interface CapturedRoute {
  method: string;
  path: string;
  handler: (request: any, reply: any) => Promise<unknown>;
}

function makeAppDouble(): { app: FastifyInstance; routes: Map<string, CapturedRoute> } {
  const routes = new Map<string, CapturedRoute>();
  const register =
    (method: string) =>
    (path: string, _opts: unknown, handler?: CapturedRoute['handler']) => {
      // Some routes are registered as (path, handler); guard for both shapes.
      const h = (typeof _opts === 'function' ? _opts : handler) as CapturedRoute['handler'];
      routes.set(`${method.toUpperCase()} ${path}`, { method, path, handler: h });
    };
  const app = {
    get: register('get'),
    post: register('post'),
    put: register('put'),
    delete: register('delete'),
    // Webhook scope uses app.register(async (scope) => {...}); run it with the
    // same double so it doesn't throw, but we don't exercise those routes here.
    register: async (plugin: (scope: FastifyInstance) => Promise<void> | void) => {
      const scope = {
        addContentTypeParser: () => undefined,
        get: register('get'),
        post: register('post'),
        put: register('put'),
        delete: register('delete'),
      } as unknown as FastifyInstance;
      await plugin(scope);
    },
  } as unknown as FastifyInstance;
  return { app, routes };
}

function makeReply(): { reply: any; sent: { code: number; body: any } } {
  const sent = { code: 200, body: undefined as any };
  const reply = {
    code(this: any, c: number) {
      sent.code = c;
      return this;
    },
    send(this: any, body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { reply, sent };
}

async function captureRoutes(): Promise<Map<string, CapturedRoute>> {
  const { app, routes } = makeAppDouble();
  await registerRoutes(app, {
    prisma: makePrismaFake(),
    jwt: {} as JwtService,
    config: CONFIG,
  });
  return routes;
}

describe('GET /api/dashboard/overview — SALES scoping (regression)', () => {
  it('gives ADMIN the full operational overview', async () => {
    const route = (await captureRoutes()).get('GET /api/dashboard/overview')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: ADMIN }, reply);

    expect(sent.code).toBe(200);
    const body = sent.body as Record<string, unknown>;
    expect(body.approvalQueue).toBeDefined();
    expect(body.upcomingPosts).toBeDefined();
    expect(body.alerts).toBeDefined();
    expect(body.kpis).toBeDefined();
    // ADMIN KPI is unscoped: sees all 4 seeded leads.
    expect((body.kpis as { totalLeads: number }).totalLeads).toBe(4);
  });

  it('gives SALES ONLY lead-scoped kpis + dataSync — no admin sections', async () => {
    const route = (await captureRoutes()).get('GET /api/dashboard/overview')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: SALES }, reply);

    expect(sent.code).toBe(200);
    const body = sent.body as Record<string, unknown>;

    // The admin operational content must be ABSENT for SALES.
    expect(body.approvalQueue).toBeUndefined();
    expect(body.upcomingPosts).toBeUndefined();
    expect(body.alerts).toBeUndefined();

    // SALES still gets its own read-only lead KPIs + the sync banner.
    expect(body.kpis).toBeDefined();
    expect(body.dataSync).toBeDefined();
    // Lead count is scoped to assigned leads only (2 of the 4 seeded).
    expect((body.kpis as { totalLeads: number }).totalLeads).toBe(2);

    // Defense-in-depth: no admin draft title / insight type leaks anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Secret campaign draft');
    expect(serialized).not.toContain('TONE_ADJUSTMENT');
    expect(serialized).not.toContain('TOKEN_EXPIRED');
  });
});

describe('GET /api/dashboard/notifications — SALES scoping (regression)', () => {
  it('gives ADMIN operational notifications', async () => {
    const route = (await captureRoutes()).get('GET /api/dashboard/notifications')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: ADMIN }, reply);

    expect(sent.code).toBe(200);
    const { notifications } = sent.body as { notifications: unknown[] };
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('gives SALES an empty notification feed (no admin task content)', async () => {
    const route = (await captureRoutes()).get('GET /api/dashboard/notifications')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: SALES }, reply);

    expect(sent.code).toBe(200);
    const { notifications } = sent.body as { notifications: unknown[] };
    expect(notifications).toEqual([]);
  });
});
