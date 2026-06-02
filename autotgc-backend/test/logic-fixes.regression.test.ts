/**
 * Regression tests for logic/code bugs found during the codebase review and
 * fixed in this pass. Each block documents the bug it locks down. These cover
 * deterministic logic only (no external social-platform/AI dependencies).
 *
 * Bugs covered:
 *  1. RBAC: SALES could read/update/match an UNASSIGNED candidate (ownerUserId
 *     undefined bypassed the route guard) — now 403 at the service layer.
 *  2. Lead date-range validation: an unparseable date string slipped past the
 *     from>to check and reached Prisma as Invalid Date (500) — now 400.
 *  3. Lead list `status` filter: an invalid enum value reached Prisma (500) —
 *     now 400 INVALID_STATUS.
 *  4. Candidate dedup: a differently-formatted stored phone (spaces/dashes)
 *     slipped past the exact-variant `in` filter — now caught by a normalized
 *     fallback scan.
 *  5. ContentPlanner.generatePlan: missing periodTo>=periodFrom guard meant
 *     item target dates ran backwards — now 400 PLAN_PERIOD_RANGE_INVALID.
 *  6. applyAnalyticsBias/matchesAny: empty topic/keyword matched every needle
 *     (JS "x".includes("") === true) — now guarded.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../src/http/authMiddleware';
import { CandidateService } from '../src/recruitment/candidateService';
import { validateDateRange } from '../src/leads/validation';
import { isLeadStatus, LEAD_STATUSES } from '../src/leads/statusMachine';

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 's-admin' };
const SALES_1: AuthInfo = { userId: 'sales-1', role: 'SALES', sessionId: 's-sales-1' };

// ---------------------------------------------------------------------------
// Minimal in-memory candidateProfile + jobOrder + candidateStageHistory store
// supporting findUnique / findMany / update / create used by the service.
// ---------------------------------------------------------------------------
interface Row {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  stage: string;
  assignedTo: string | null;
  matchedJobOrderId: string | null;
  desiredMarket: string | null;
  desiredVisaType: string | null;
  createdAt: Date;
  [k: string]: unknown;
}

function cand(p: Partial<Row>): Row {
  return {
    id: p.id ?? `c-${Math.random().toString(36).slice(2)}`,
    fullName: p.fullName ?? 'X',
    phone: p.phone ?? null,
    email: p.email ?? null,
    stage: p.stage ?? 'NEW',
    assignedTo: p.assignedTo ?? null,
    matchedJobOrderId: p.matchedJobOrderId ?? null,
    desiredMarket: p.desiredMarket ?? null,
    desiredVisaType: p.desiredVisaType ?? null,
    createdAt: p.createdAt ?? new Date(),
    ...p,
  };
}

function whereMatch(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      const ors = cond as Array<Record<string, unknown>>;
      if (!ors.some((o) => whereMatch(row, o))) return false;
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === 'object') {
      const obj = cond as Record<string, unknown>;
      if ('in' in obj) {
        if (!(obj.in as unknown[]).includes(value)) return false;
      } else if ('equals' in obj) {
        if (String(value ?? '').toLowerCase() !== String(obj.equals).toLowerCase()) return false;
      } else if ('not' in obj) {
        if (value === obj.not) return false;
      } else if ('contains' in obj) {
        if (!String(value ?? '').toLowerCase().includes(String(obj.contains).toLowerCase())) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function fakePrisma(seed: Row[] = [], jobOrders: Array<{ id: string; code: string }> = []) {
  const store = [...seed];
  const history: Array<Record<string, unknown>> = [];
  const prisma = {
    candidateProfile: {
      findUnique: async (args: { where: { id: string } }) =>
        store.find((r) => r.id === args.where.id) ? { ...store.find((r) => r.id === args.where.id)! } : null,
      findMany: async (args?: { where?: Record<string, unknown>; select?: unknown }) =>
        store.filter((r) => whereMatch(r, args?.where)).map((r) => ({ ...r })),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.find((r) => r.id === args.where.id)!;
        for (const [k, v] of Object.entries(args.data)) {
          // ignore relation ops (connect/disconnect) for this harness
          if (v && typeof v === 'object' && ('connect' in v || 'disconnect' in v)) continue;
          row[k] = v as unknown;
        }
        return { ...row };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = cand({ id: `c-${store.length + 1}`, ...(args.data as Partial<Row>) });
        store.push(row);
        return { ...row };
      },
    },
    candidateStageHistory: {
      create: async (args: { data: Record<string, unknown> }) => {
        history.push(args.data);
        return { ...args.data };
      },
      findMany: async () => [...history],
    },
    jobOrder: {
      findUnique: async (args: { where: { id: string } }) =>
        jobOrders.find((j) => j.id === args.where.id) ?? null,
    },
  } as unknown as PrismaClient;
  return { prisma, store, history };
}

// ---------------------------------------------------------------------------
// Bug 1: SALES vs UNASSIGNED candidate (RBAC ownership at service layer)
// ---------------------------------------------------------------------------
describe('Bug 1 — SALES cannot access an unassigned candidate', () => {
  it('get(): SALES on an UNASSIGNED candidate -> 403', async () => {
    const { prisma } = fakePrisma([cand({ id: 'u1', assignedTo: null })]);
    const svc = new CandidateService(prisma);
    await expect(svc.get('u1', SALES_1)).rejects.toMatchObject({ status: 403 });
  });

  it('get(): SALES on a candidate assigned to ANOTHER sales -> 403', async () => {
    const { prisma } = fakePrisma([cand({ id: 'o1', assignedTo: 'sales-2' })]);
    const svc = new CandidateService(prisma);
    await expect(svc.get('o1', SALES_1)).rejects.toMatchObject({ status: 403 });
  });

  it('get(): SALES on its OWN candidate -> ok', async () => {
    const { prisma } = fakePrisma([cand({ id: 'm1', assignedTo: 'sales-1' })]);
    const svc = new CandidateService(prisma);
    const got = await svc.get('m1', SALES_1);
    expect((got as { id: string }).id).toBe('m1');
  });

  it('get(): ADMIN on an unassigned candidate -> ok', async () => {
    const { prisma } = fakePrisma([cand({ id: 'u1', assignedTo: null })]);
    const svc = new CandidateService(prisma);
    const got = await svc.get('u1', ADMIN);
    expect((got as { id: string }).id).toBe('u1');
  });

  it('update(): SALES on an UNASSIGNED candidate -> 403 (no write)', async () => {
    const { prisma, store } = fakePrisma([cand({ id: 'u1', assignedTo: null, fullName: 'Before' })]);
    const svc = new CandidateService(prisma);
    await expect(svc.update('u1', { fullName: 'Hacked' }, SALES_1)).rejects.toMatchObject({ status: 403 });
    expect(store[0].fullName).toBe('Before');
  });

  it('matchToJobOrder(): SALES on an UNASSIGNED candidate -> 403', async () => {
    const { prisma } = fakePrisma(
      [cand({ id: 'u1', assignedTo: null })],
      [{ id: 'jo1', code: 'KN001' }],
    );
    const svc = new CandidateService(prisma);
    await expect(svc.matchToJobOrder('u1', 'jo1', SALES_1)).rejects.toMatchObject({ status: 403 });
  });
});

// ---------------------------------------------------------------------------
// Bug 4: dedup catches a differently-formatted stored phone
// ---------------------------------------------------------------------------
describe('Bug 4 — candidate dedup catches a formatted stored phone', () => {
  it('findDuplicate() matches a stored "090-000-0000" when searching "0900000000"', async () => {
    const { prisma } = fakePrisma([cand({ id: 'd1', phone: '090-000-0000' })]);
    const svc = new CandidateService(prisma);
    const dup = await svc.findDuplicate('0900000000', null);
    expect(dup?.id).toBe('d1');
  });

  it('create() rejects a duplicate even when the stored phone was formatted', async () => {
    const { prisma, store } = fakePrisma([cand({ id: 'd1', fullName: 'A', phone: '+84 90 000 0000' })]);
    const svc = new CandidateService(prisma);
    await expect(
      svc.create({ fullName: 'B', phone: '0900000000' }, ADMIN),
    ).rejects.toMatchObject({ status: 409, code: 'CANDIDATE_DUPLICATE' });
    expect(store).toHaveLength(1);
  });

  it('findDuplicate() returns null when no normalized match exists', async () => {
    const { prisma } = fakePrisma([cand({ id: 'd1', phone: '0911111111' })]);
    const svc = new CandidateService(prisma);
    const dup = await svc.findDuplicate('0900000000', null);
    expect(dup).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bug 2: lead date-range validation rejects unparseable dates with 400
// ---------------------------------------------------------------------------
describe('Bug 2 — validateDateRange rejects invalid date strings', () => {
  it('rejects an unparseable from date', () => {
    const r = validateDateRange('not-a-date', '2026-01-01');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects an unparseable to date', () => {
    const r = validateDateRange('2026-01-01', 'garbage');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('still rejects from>to', () => {
    const r = validateDateRange('2026-02-01', '2026-01-01');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_DATE_RANGE');
  });

  it('accepts a valid range and empty/omitted dates', () => {
    expect(validateDateRange('2026-01-01', '2026-02-01').ok).toBe(true);
    expect(validateDateRange(undefined, undefined).ok).toBe(true);
    expect(validateDateRange('', '').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 3: lead status enum guard
// ---------------------------------------------------------------------------
describe('Bug 3 — isLeadStatus guards the list status filter', () => {
  it('accepts every real status', () => {
    for (const s of LEAD_STATUSES) expect(isLeadStatus(s)).toBe(true);
  });
  it('rejects unknown / malformed values', () => {
    expect(isLeadStatus('BOGUS')).toBe(false);
    expect(isLeadStatus('new')).toBe(false); // case-sensitive enum
    expect(isLeadStatus('')).toBe(false);
    expect(isLeadStatus(null)).toBe(false);
    expect(isLeadStatus(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug 5: ContentPlanner.generatePlan rejects an inverted period range
// ---------------------------------------------------------------------------
import { ContentPlanner, applyAnalyticsBias } from '../src/marketing/planning/contentPlanner';
import type { PlanTrendInput } from '../src/marketing/planning/contentPlanner';

/** A ContentPlanner with a prisma stub that returns no trends (heuristic path). */
function plannerStub(): ContentPlanner {
  const prisma = {
    trendSignal: { findMany: async () => [] },
    aiPromptContext: { findFirst: async () => null },
    contentPlan: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'plan-1', ...args.data }),
    },
    contentPlanItem: {
      createMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
  } as unknown as ConstructorParameters<typeof ContentPlanner>[0];
  return new ContentPlanner(prisma);
}

describe('Bug 5 — generatePlan rejects periodTo < periodFrom', () => {
  it('throws 400 PLAN_PERIOD_RANGE_INVALID when to < from', async () => {
    const planner = plannerStub();
    await expect(
      planner.generatePlan({
        market: 'JAPAN',
        objective: 'Lead',
        periodFrom: '2026-02-01',
        periodTo: '2026-01-01',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'PLAN_PERIOD_RANGE_INVALID' });
  });

  it('still rejects an unparseable period date (400)', async () => {
    const planner = plannerStub();
    await expect(
      planner.generatePlan({
        market: 'JAPAN',
        objective: 'Lead',
        periodFrom: 'garbage',
        periodTo: '2026-01-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// Bug 6: applyAnalyticsBias / matchesAny — empty topic/keyword no longer
// matches every needle.
// ---------------------------------------------------------------------------
describe('Bug 6 — empty topic/keyword does not match every needle', () => {
  const emptyTopicTrend: PlanTrendInput = { topic: '', keyword: '', demandScore: 50 };
  const realTrend: PlanTrendInput = { topic: 'lương nhật bản', keyword: 'xkld nhat', demandScore: 40 };

  it('a trend with empty topic+keyword is NOT dropped by an unrelated avoid topic', () => {
    const kept = applyAnalyticsBias([emptyTopicTrend, realTrend], [], ['điều dưỡng']);
    // Both survive: neither matches "điều dưỡng".
    expect(kept).toHaveLength(2);
  });

  it('a trend with empty topic+keyword is NOT boosted by an unrelated top topic', () => {
    // realTrend has higher relevance only if boosted; empty trend must not get boost=1.
    const ordered = applyAnalyticsBias([emptyTopicTrend, realTrend], ['nhật'], []);
    // "nhật" matches realTrend (topic includes it) -> realTrend boosted to front;
    // empty trend must NOT be boosted, so realTrend ranks first.
    expect(ordered[0]).toBe(realTrend);
  });

  it('real avoid topic still filters a matching trend', () => {
    const kept = applyAnalyticsBias([realTrend], [], ['nhật']);
    expect(kept).toHaveLength(0);
  });
});
