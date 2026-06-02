/**
 * Route tests for the company-reporting routes (task 3.7).
 *
 * Mirrors the FastifyInstance-double pattern from `workAssistant.test.ts`: a
 * minimal Fastify test double captures the registered handlers so we can invoke
 * their bodies directly (the requireAuth/rbacGuard preHandlers are out of scope
 * here — RBAC denial for SALES writes is enforced redundantly inside
 * `ReportService`, which is what these handlers delegate to).
 *
 * Covers:
 *   - POST /api/v1/reports/generate → 201 (Req 5.1)
 *   - GET  /api/v1/reports          → 200 list works (Req 5.1)
 *   - POST /api/v1/reports/:id/transition → body validation (400 on bad target)
 *   - SALES is blocked from PUT (403) and transition (403) (Req 5.3) while
 *     allowed to GET the list, seeing APPROVED-only reports (Req 5.2).
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { registerReportingRoutes } from '../src/reporting/routes';
import { ValidationError, ForbiddenError } from '../src/infra/errors';
import type { JwtService } from '../src/auth/jwt';

// ===========================================================================
// In-memory Prisma fake — only the methods the reporting routes/service touch.
// ===========================================================================

interface ReportRow {
  id: string;
  reportType: string;
  periodFrom: Date;
  periodTo: Date;
  periodLabel: string;
  status: string;
  content: unknown;
  aiGenerated: boolean;
  scopeUserId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const NOW = new Date('2025-06-09T00:00:00.000Z');

function emptyContent(): Record<string, unknown> {
  return {
    executiveSummary: '',
    contentPerformance: {
      publishedCount: 0,
      avgConversionRate: 'INSUFFICIENT_DATA',
      avgEngagementRate: 'INSUFFICIENT_DATA',
      avgCtaClickRate: 'INSUFFICIENT_DATA',
    },
    recruitmentFunnelByMarket: [],
    leadsBySource: [],
    highlights: [],
    recommendations: [],
  };
}

/**
 * Build a Prisma fake seeded with `seed` reports. Performance/lead/candidate
 * tables are empty so generate produces an INSUFFICIENT_DATA report
 * deterministically (no Gemini wired).
 */
function makePrismaFake(seed: ReportRow[] = []): { prisma: PrismaClient; store: ReportRow[] } {
  const store = [...seed];
  let seq = store.length;

  const matches = (row: ReportRow, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    if (where.reportType !== undefined && row.reportType !== where.reportType) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    return true;
  };

  const prisma = {
    performanceRecord: { findMany: async () => [] },
    lead: { findMany: async () => [] },
    candidateProfile: { findMany: async () => [] },
    auditEntry: {
      create: async (args: { data: Record<string, unknown> }) => ({
        id: `audit-${seq++}`,
        recordedAt: NOW,
        ...args.data,
      }),
    },
    companyReport: {
      create: async (args: { data: Record<string, unknown> }) => {
        const d = args.data as Partial<ReportRow>;
        const row: ReportRow = {
          id: `report-${++seq}`,
          reportType: d.reportType as string,
          periodFrom: d.periodFrom as Date,
          periodTo: d.periodTo as Date,
          periodLabel: d.periodLabel as string,
          status: d.status as string,
          content: d.content,
          aiGenerated: (d.aiGenerated as boolean) ?? false,
          scopeUserId: (d.scopeUserId as string | null) ?? null,
          createdBy: (d.createdBy as string | null) ?? null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        store.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        store.find((r) => r.id === args.where.id) ?? null,
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        store.filter((r) => matches(r, args?.where)),
      count: async (args?: { where?: Record<string, unknown> }) =>
        store.filter((r) => matches(r, args?.where)).length,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = store.findIndex((r) => r.id === args.where.id);
        const updated = { ...store[idx], ...(args.data as Partial<ReportRow>), updatedAt: NOW };
        store[idx] = updated;
        return updated;
      },
    },
  } as unknown as PrismaClient;

  return { prisma, store };
}

function makeReport(over: Partial<ReportRow> & { id: string }): ReportRow {
  return {
    id: over.id,
    reportType: over.reportType ?? 'WEEKLY',
    periodFrom: over.periodFrom ?? new Date('2025-06-02T00:00:00.000Z'),
    periodTo: over.periodTo ?? new Date('2025-06-09T00:00:00.000Z'),
    periodLabel: over.periodLabel ?? '2025-W23',
    status: over.status ?? 'DRAFT',
    content: over.content ?? emptyContent(),
    aiGenerated: over.aiGenerated ?? false,
    scopeUserId: over.scopeUserId ?? null,
    createdBy: over.createdBy ?? null,
    createdAt: over.createdAt ?? NOW,
    updatedAt: over.updatedAt ?? NOW,
  };
}

// ===========================================================================
// Fastify test double — captures handlers so we can invoke bodies directly.
// ===========================================================================

interface CapturedRoute {
  method: 'get' | 'post' | 'put';
  path: string;
  handler: (request: any, reply: any) => Promise<unknown>;
}

function makeAppDouble(): { app: FastifyInstance; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = [];
  const register =
    (method: CapturedRoute['method']) =>
    (path: string, _opts: unknown, handler: CapturedRoute['handler']) => {
      routes.push({ method, path, handler });
    };
  const app = {
    get: register('get'),
    post: register('post'),
    put: register('put'),
  } as unknown as FastifyInstance;
  return { app, routes };
}

/** A reply double capturing status, headers, and the sent body. */
function makeReply(): {
  reply: any;
  sent: { code: number; body: unknown; headers: Record<string, string> };
} {
  const sent = { code: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const reply = {
    code(this: any, c: number) {
      sent.code = c;
      return this;
    },
    header(this: any, k: string, v: string) {
      sent.headers[k] = v;
      return this;
    },
    send(this: any, body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { reply, sent };
}

function registerRoutes(prisma: PrismaClient): Map<string, CapturedRoute> {
  const { app, routes } = makeAppDouble();
  registerReportingRoutes(app, { prisma, jwt: {} as JwtService });
  const map = new Map<string, CapturedRoute>();
  for (const r of routes) map.set(`${r.method.toUpperCase()} ${r.path}`, r);
  return map;
}

const ADMIN = { userId: 'admin', role: 'ADMIN' as const, sessionId: 's1' };
const SALES = { userId: 'sales', role: 'SALES' as const, sessionId: 's2' };

// ===========================================================================
// POST /api/v1/reports/generate → 201 (Req 5.1)
// ===========================================================================

describe('POST /api/v1/reports/generate', () => {
  it('generates a report and responds 201', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/reports/generate')!;
    const { reply, sent } = makeReply();

    await route.handler(
      { body: { reportType: 'WEEKLY' }, auth: ADMIN, query: {}, params: {} },
      reply,
    );

    expect(sent.code).toBe(201);
    const view = sent.body as { reportType: string; status: string };
    expect(view.reportType).toBe('WEEKLY');
    // Empty data sources → INSUFFICIENT_DATA report.
    expect(view.status).toBe('INSUFFICIENT_DATA');
  });

  it('rejects an invalid reportType with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/reports/generate')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ body: { reportType: 'DAILY' }, auth: ADMIN, query: {}, params: {} }, reply),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a malformed explicit period with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/reports/generate')!;
    const { reply } = makeReply();

    await expect(
      route.handler(
        {
          body: {
            reportType: 'MONTHLY',
            period: { label: '2025-06', from: '2025-06-30', to: '2025-06-01' },
          },
          auth: ADMIN,
          query: {},
          params: {},
        },
        reply,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ===========================================================================
// GET /api/v1/reports → 200 list works (Req 5.1) + SALES APPROVED-only (Req 5.2)
// ===========================================================================

describe('GET /api/v1/reports', () => {
  it('returns all reports for ADMIN (200)', async () => {
    const { prisma } = makePrismaFake([
      makeReport({ id: 'r-draft', status: 'DRAFT' }),
      makeReport({ id: 'r-approved', status: 'APPROVED' }),
    ]);
    const route = registerRoutes(prisma).get('GET /api/v1/reports')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: ADMIN, query: {}, params: {} }, reply);

    expect(sent.code).toBe(200);
    const body = sent.body as { items: unknown[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
  });

  it('restricts SALES to APPROVED reports only (Req 5.2)', async () => {
    const { prisma } = makePrismaFake([
      makeReport({ id: 'r-draft', status: 'DRAFT' }),
      makeReport({ id: 'r-approved', status: 'APPROVED' }),
    ]);
    const route = registerRoutes(prisma).get('GET /api/v1/reports')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: SALES, query: {}, params: {} }, reply);

    expect(sent.code).toBe(200);
    const body = sent.body as { items: Array<{ status: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items.every((r) => r.status === 'APPROVED')).toBe(true);
  });

  it('rejects an invalid status filter with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('GET /api/v1/reports')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ auth: ADMIN, query: { status: 'BOGUS' }, params: {} }, reply),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ===========================================================================
// POST /api/v1/reports/:id/transition — body validation + SALES 403
// ===========================================================================

describe('POST /api/v1/reports/:id/transition', () => {
  it('rejects a missing/invalid target with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'DRAFT' })]);
    const route = registerRoutes(prisma).get('POST /api/v1/reports/:id/transition')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ params: { id: 'r1' }, body: { target: 'NONSENSE' }, auth: ADMIN, query: {} }, reply),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('transitions DRAFT → IN_REVIEW for ADMIN (200)', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'DRAFT' })]);
    const route = registerRoutes(prisma).get('POST /api/v1/reports/:id/transition')!;
    const { reply, sent } = makeReply();

    await route.handler(
      { params: { id: 'r1' }, body: { target: 'IN_REVIEW' }, auth: ADMIN, query: {} },
      reply,
    );

    expect(sent.code).toBe(200);
    expect((sent.body as { status: string }).status).toBe('IN_REVIEW');
  });

  it('blocks SALES from transitioning a report (403)', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'DRAFT' })]);
    const route = registerRoutes(prisma).get('POST /api/v1/reports/:id/transition')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ params: { id: 'r1' }, body: { target: 'IN_REVIEW' }, auth: SALES, query: {} }, reply),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ===========================================================================
// PUT /api/v1/reports/:id — SALES blocked (403), ADMIN edits (200)
// ===========================================================================

describe('PUT /api/v1/reports/:id', () => {
  it('blocks SALES from editing report content (403)', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'DRAFT' })]);
    const route = registerRoutes(prisma).get('PUT /api/v1/reports/:id')!;
    const { reply } = makeReply();

    await expect(
      route.handler(
        { params: { id: 'r1' }, body: { highlights: ['x'] }, auth: SALES, query: {} },
        reply,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets ADMIN edit content of a DRAFT report (200)', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'DRAFT' })]);
    const route = registerRoutes(prisma).get('PUT /api/v1/reports/:id')!;
    const { reply, sent } = makeReply();

    await route.handler(
      { params: { id: 'r1' }, body: { highlights: ['điểm nổi bật'] }, auth: ADMIN, query: {} },
      reply,
    );

    expect(sent.code).toBe(200);
    const view = sent.body as { content: { highlights: string[] } };
    expect(view.content.highlights).toEqual(['điểm nổi bật']);
  });
});

// ===========================================================================
// GET /api/v1/reports/:id — SALES allowed on APPROVED (Req 5.2)
// ===========================================================================

describe('GET /api/v1/reports/:id', () => {
  it('lets SALES read an APPROVED report (200)', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'APPROVED' })]);
    const route = registerRoutes(prisma).get('GET /api/v1/reports/:id')!;
    const { reply, sent } = makeReply();

    await route.handler({ params: { id: 'r1' }, auth: SALES, query: {} }, reply);

    expect(sent.code).toBe(200);
    expect((sent.body as { status: string }).status).toBe('APPROVED');
  });

  it('blocks SALES from reading a non-APPROVED report (403)', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'DRAFT' })]);
    const route = registerRoutes(prisma).get('GET /api/v1/reports/:id')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ params: { id: 'r1' }, auth: SALES, query: {} }, reply),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ===========================================================================
// GET /api/v1/reports/:id/export — attachment headers from the export result
// ===========================================================================

describe('GET /api/v1/reports/:id/export', () => {
  it('sets content-disposition + content-type from the export result (200)', async () => {
    const { prisma } = makePrismaFake([makeReport({ id: 'r1', status: 'APPROVED' })]);
    const route = registerRoutes(prisma).get('GET /api/v1/reports/:id/export')!;
    const { reply, sent } = makeReply();

    await route.handler({ params: { id: 'r1' }, auth: ADMIN, query: {} }, reply);

    expect(sent.code).toBe(200);
    expect(sent.headers['Content-Type']).toContain('text/markdown');
    expect(sent.headers['Content-Disposition']).toContain('attachment; filename="');
    expect(typeof sent.body).toBe('string');
  });
});
