import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../src/http/authMiddleware';
import {
  CandidateService,
  normalizePhone,
  normalizeEmail,
} from '../src/recruitment/candidateService';
import {
  computeFunnelRates,
  emptyFunnelCounts,
  CandidateAnalyticsService,
} from '../src/recruitment/candidateAnalytics';
import type { FunnelCounts } from '../src/recruitment/candidateAnalytics';
import { CANDIDATE_STAGES } from '../src/recruitment/candidateStateMachine';

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-1' };
const SALES_1: AuthInfo = { userId: 'sales-1', role: 'SALES', sessionId: 'sess-2' };

// ---- Fake Prisma helpers ----------------------------------------------------

interface StoredCandidate {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  stage: string;
  desiredMarket: string | null;
  desiredVisaType: string | null;
  japaneseLevel: string;
  assignedTo: string | null;
  branchId: string | null;
  matchedJobOrderId: string | null;
  source: string;
  createdAt: Date;
}

function makeCandidate(p: Partial<StoredCandidate>): StoredCandidate {
  return {
    id: p.id ?? `cand-${Math.random().toString(36).slice(2)}`,
    fullName: p.fullName ?? 'Unknown',
    phone: p.phone ?? null,
    email: p.email ?? null,
    stage: p.stage ?? 'NEW',
    desiredMarket: p.desiredMarket ?? null,
    desiredVisaType: p.desiredVisaType ?? null,
    japaneseLevel: p.japaneseLevel ?? 'NONE',
    assignedTo: p.assignedTo ?? null,
    branchId: p.branchId ?? null,
    matchedJobOrderId: p.matchedJobOrderId ?? null,
    source: p.source ?? '',
    createdAt: p.createdAt ?? new Date(),
  };
}

/** Tiny in-memory candidateProfile store covering the methods under test. */
function fakeStore(seed: StoredCandidate[] = []): {
  prisma: PrismaClient;
  store: StoredCandidate[];
} {
  const store = [...seed];

  const matchWhere = (c: StoredCandidate, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        const ors = cond as Array<Record<string, unknown>>;
        if (!ors.some((o) => matchWhere(c, o))) return false;
        continue;
      }
      const value = (c as unknown as Record<string, unknown>)[key];
      if (cond && typeof cond === 'object') {
        const obj = cond as Record<string, unknown>;
        if ('in' in obj) {
          if (!(obj.in as unknown[]).includes(value)) return false;
        } else if ('contains' in obj) {
          const hay = String(value ?? '').toLowerCase();
          if (!hay.includes(String(obj.contains).toLowerCase())) return false;
        } else if ('equals' in obj) {
          const a = String(value ?? '').toLowerCase();
          if (a !== String(obj.equals).toLowerCase()) return false;
        } else if ('not' in obj) {
          if (value === obj.not) return false;
        }
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };

  const prisma = {
    candidateProfile: {
      findMany: async (args?: { where?: Record<string, unknown>; skip?: number; take?: number; select?: unknown }) => {
        let rows = store.filter((c) => matchWhere(c, args?.where));
        if (typeof args?.skip === 'number') rows = rows.slice(args.skip);
        if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
        return rows.map((r) => ({ ...r }));
      },
      count: async (args?: { where?: Record<string, unknown> }) =>
        store.filter((c) => matchWhere(c, args?.where)).length,
      create: async (args: { data: Record<string, unknown> }) => {
        const created = makeCandidate({
          id: `cand-${store.length + 1}`,
          ...(args.data as Partial<StoredCandidate>),
        });
        store.push(created);
        return { ...created };
      },
      groupBy: async (args: { by: string[]; where?: Record<string, unknown> }) => {
        const field = args.by[0];
        const rows = store.filter((c) => matchWhere(c, args.where));
        const buckets = new Map<unknown, number>();
        for (const r of rows) {
          const key = (r as unknown as Record<string, unknown>)[field] ?? null;
          buckets.set(key, (buckets.get(key) ?? 0) + 1);
        }
        return [...buckets.entries()].map(([key, count]) => ({
          [field]: key,
          _count: { _all: count },
        }));
      },
    },
  } as unknown as PrismaClient;

  return { prisma, store };
}

// ---- Property: funnel rate divide-by-zero safety ----------------------------

describe('computeFunnelRates', () => {
  // Feature: recruitment-crm, Property 3: funnel rate divide-by-zero safety
  it('Property 3: divide-by-zero safe; all-zero => 0 + insufficient; rates in [0,100], never NaN/Infinity', () => {
    const stageArb = fc.record(
      Object.fromEntries(CANDIDATE_STAGES.map((s) => [s, fc.nat({ max: 1000 })])) as Record<
        string,
        fc.Arbitrary<number>
      >,
    ) as unknown as fc.Arbitrary<FunnelCounts>;

    fc.assert(
      fc.property(stageArb, (counts) => {
        const { rates, total, insufficient } = computeFunnelRates(counts);
        const all = [rates.contactedRate, rates.qualifiedRate, rates.interviewRate, rates.departedRate];
        for (const r of all) {
          expect(Number.isFinite(r)).toBe(true);
          expect(Number.isNaN(r)).toBe(false);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(100);
        }
        if (total === 0) {
          expect(insufficient).toBe(true);
          for (const r of all) expect(r).toBe(0);
        } else {
          expect(insufficient).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('all-zero counts produce 0 rates with the insufficient flag', () => {
    const result = computeFunnelRates(emptyFunnelCounts());
    expect(result.total).toBe(0);
    expect(result.insufficient).toBe(true);
    expect(result.rates).toEqual({
      contactedRate: 0,
      qualifiedRate: 0,
      interviewRate: 0,
      departedRate: 0,
    });
  });

  it('computes monotonic funnel rates for a known distribution', () => {
    const counts = emptyFunnelCounts();
    counts.NEW = 10;
    counts.CONSULTING = 10;
    counts.PROFILE_COLLECTED = 10;
    counts.INTERVIEW_SCHEDULED = 10;
    counts.DEPARTED = 10;
    // total = 50
    const { rates } = computeFunnelRates(counts);
    expect(rates.contactedRate).toBeCloseTo(80); // 40/50
    expect(rates.qualifiedRate).toBeCloseTo(60); // 30/50
    expect(rates.interviewRate).toBeCloseTo(40); // 20/50
    expect(rates.departedRate).toBeCloseTo(20); // 10/50
  });
});

// ---- Property/unit: phone + email normalization ----------------------------

describe('normalizePhone / normalizeEmail', () => {
  // Feature: recruitment-crm, Property 4: +84 and 0-prefix variants normalize equal
  it('Property 4: +84 and 0-prefix variants of the same number map equal', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[1-9][0-9]{8}$/),
        (rest) => {
          const national = `0${rest}`;
          const intl = `+84${rest}`;
          const intl0084 = `0084${rest}`;
          expect(normalizePhone(national)).toBe(normalizePhone(intl));
          expect(normalizePhone(national)).toBe(normalizePhone(intl0084));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('strips spaces, dots, dashes and parentheses', () => {
    expect(normalizePhone('+84 90 000.00-00')).toBe(normalizePhone('0900000000'));
    expect(normalizePhone('(090) 000 0000')).toBe('0900000000');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });

  it('normalizeEmail case-folds and trims', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
    expect(normalizeEmail(null)).toBe('');
    fc.assert(
      fc.property(fc.emailAddress(), (e) => {
        expect(normalizeEmail(e.toUpperCase())).toBe(normalizeEmail(e.toLowerCase()));
      }),
      { numRuns: 100 },
    );
  });
});

// ---- Unit: create dedup -----------------------------------------------------

describe('CandidateService dedup on create', () => {
  it('rejects a duplicate phone with 409 CANDIDATE_DUPLICATE', async () => {
    const { prisma, store } = fakeStore([
      makeCandidate({ id: 'existing-1', fullName: 'A', phone: '0900000000' }),
    ]);
    const service = new CandidateService(prisma);
    await expect(
      service.create({ fullName: 'B', phone: '+84 900 000 000' }, ADMIN),
    ).rejects.toMatchObject({ status: 409, code: 'CANDIDATE_DUPLICATE' });
    // No new candidate written.
    expect(store).toHaveLength(1);
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    const { prisma } = fakeStore([
      makeCandidate({ id: 'existing-1', fullName: 'A', email: 'dup@example.com' }),
    ]);
    const service = new CandidateService(prisma);
    await expect(
      service.create({ fullName: 'B', email: 'DUP@EXAMPLE.COM' }, ADMIN),
    ).rejects.toMatchObject({ status: 409, code: 'CANDIDATE_DUPLICATE' });
  });

  it('allows a duplicate when allowDuplicate: true', async () => {
    const { prisma, store } = fakeStore([
      makeCandidate({ id: 'existing-1', fullName: 'A', phone: '0900000000' }),
    ]);
    const service = new CandidateService(prisma);
    const created = await service.create(
      { fullName: 'B', phone: '0900000000' },
      ADMIN,
      { allowDuplicate: true },
    );
    expect(created).toBeTruthy();
    expect(store).toHaveLength(2);
  });

  it('creates normally when no duplicate exists (existing-test compatibility)', async () => {
    const { prisma, store } = fakeStore();
    const service = new CandidateService(prisma);
    const created = await service.create({ fullName: 'New One', phone: '0911111111' }, ADMIN);
    expect(created).toBeTruthy();
    expect(store).toHaveLength(1);
  });

  it('validates fullName/contact BEFORE the dup check', async () => {
    const { prisma } = fakeStore([
      makeCandidate({ id: 'existing-1', fullName: 'A', phone: '0900000000' }),
    ]);
    const service = new CandidateService(prisma);
    await expect(service.create({ fullName: '  ', phone: '0900000000' }, ADMIN)).rejects.toMatchObject({
      status: 400,
      code: 'FULL_NAME_REQUIRED',
    });
  });
});

// ---- Unit: search -----------------------------------------------------------

describe('CandidateService.search', () => {
  const seed = [
    makeCandidate({ id: 'c1', fullName: 'Nguyen Van An', phone: '0900000001', assignedTo: 'sales-1' }),
    makeCandidate({ id: 'c2', fullName: 'Tran Thi Bich', phone: '0900000002', email: 'bich@example.com', assignedTo: 'sales-2' }),
    makeCandidate({ id: 'c3', fullName: 'Le Van Cuong', phone: '0933333333', assignedTo: 'sales-1' }),
  ];

  it('q matches by partial name (case-insensitive)', async () => {
    const { prisma } = fakeStore(seed);
    const service = new CandidateService(prisma);
    const result = await service.search({ q: 'nguyen' }, 1, 20, ADMIN);
    expect(result.items.map((i) => (i as { id: string }).id)).toEqual(['c1']);
  });

  it('q matches by partial phone', async () => {
    const { prisma } = fakeStore(seed);
    const service = new CandidateService(prisma);
    const result = await service.search({ q: '093' }, 1, 20, ADMIN);
    expect(result.items.map((i) => (i as { id: string }).id)).toEqual(['c3']);
  });

  it('SALES search is restricted to assignedTo', async () => {
    const { prisma } = fakeStore(seed);
    const service = new CandidateService(prisma);
    const result = await service.search({}, 1, 20, SALES_1);
    const ids = result.items.map((i) => (i as { id: string }).id).sort();
    expect(ids).toEqual(['c1', 'c3']);
    expect(result.total).toBe(2);
  });
});

// ---- Unit: analytics funnel + scoping --------------------------------------

describe('CandidateAnalyticsService.funnel', () => {
  const seed = [
    makeCandidate({ id: 'c1', stage: 'NEW', desiredMarket: 'JAPAN', assignedTo: 'sales-1' }),
    makeCandidate({ id: 'c2', stage: 'CONSULTING', desiredMarket: 'JAPAN', assignedTo: 'sales-1' }),
    makeCandidate({ id: 'c3', stage: 'DEPARTED', desiredMarket: 'GERMANY', assignedTo: 'sales-2' }),
    makeCandidate({ id: 'c4', stage: 'DEPARTED', desiredMarket: 'JAPAN', assignedTo: 'sales-2' }),
  ];

  it('groups counts correctly for ADMIN (all candidates)', async () => {
    const { prisma } = fakeStore(seed);
    const analytics = new CandidateAnalyticsService(prisma);
    const result = await analytics.funnel({}, ADMIN);
    expect(result.counts.NEW).toBe(1);
    expect(result.counts.CONSULTING).toBe(1);
    expect(result.counts.DEPARTED).toBe(2);
    expect(result.total).toBe(4);
    expect(result.insufficient).toBe(false);
    expect(result.rates.departedRate).toBeCloseTo(50); // 2/4
  });

  it('SALES scoping restricts the funnel to assignedTo', async () => {
    const { prisma } = fakeStore(seed);
    const analytics = new CandidateAnalyticsService(prisma);
    const result = await analytics.funnel({}, SALES_1);
    // sales-1 owns c1 (NEW) + c2 (CONSULTING) only.
    expect(result.total).toBe(2);
    expect(result.counts.NEW).toBe(1);
    expect(result.counts.CONSULTING).toBe(1);
    expect(result.counts.DEPARTED).toBe(0);
    expect(result.rates.departedRate).toBe(0);
  });

  it('rejects an invalid date range (from > to) with 400', async () => {
    const { prisma } = fakeStore(seed);
    const analytics = new CandidateAnalyticsService(prisma);
    await expect(
      analytics.funnel({ from: '2024-12-31', to: '2024-01-01' }, ADMIN),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DATE_RANGE' });
  });

  it('empty result set yields insufficient funnel', async () => {
    const { prisma } = fakeStore([]);
    const analytics = new CandidateAnalyticsService(prisma);
    const result = await analytics.funnel({}, ADMIN);
    expect(result.total).toBe(0);
    expect(result.insufficient).toBe(true);
  });

  it('conversionByJobOrder counts departed per job order', async () => {
    const { prisma } = fakeStore([
      makeCandidate({ id: 'c1', stage: 'MATCHED', matchedJobOrderId: 'jo-1' }),
      makeCandidate({ id: 'c2', stage: 'DEPARTED', matchedJobOrderId: 'jo-1' }),
      makeCandidate({ id: 'c3', stage: 'DEPARTED', matchedJobOrderId: 'jo-2' }),
      makeCandidate({ id: 'c4', stage: 'NEW', matchedJobOrderId: null }),
    ]);
    const analytics = new CandidateAnalyticsService(prisma);
    const buckets = await analytics.conversionByJobOrder(undefined, undefined, ADMIN);
    const jo1 = buckets.find((b) => b.matchedJobOrderId === 'jo-1');
    const jo2 = buckets.find((b) => b.matchedJobOrderId === 'jo-2');
    expect(jo1).toMatchObject({ total: 2, departed: 1 });
    expect(jo1?.departedRate).toBeCloseTo(50);
    expect(jo2).toMatchObject({ total: 1, departed: 1, departedRate: 100 });
  });
});
