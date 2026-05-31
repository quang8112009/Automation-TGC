import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import {
  ContentPlanner,
  defaultChannelFormatMatrix,
  distributePlanItems,
  CHANNELS,
  CONTENT_FORMATS,
} from '../src/marketing/planning/contentPlanner';
import type {
  ChannelFormat,
  PlanTrendInput,
  PlanObjective,
} from '../src/marketing/planning/contentPlanner';
import { AppError } from '../src/infra/errors';

// ---- Generators -------------------------------------------------------------

const objectiveArb: fc.Arbitrary<PlanObjective> = fc.constantFrom('Lead', 'View', 'Follow');

const trendArb: fc.Arbitrary<PlanTrendInput> = fc.record({
  id: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
  topic: fc.string({ maxLength: 24 }),
  keyword: fc.string({ maxLength: 24 }),
  demandScore: fc.integer({ min: 0, max: 100 }),
});

const trendsArb = fc.array(trendArb, { minLength: 1, maxLength: 10 });

const matrixArb: fc.Arbitrary<ChannelFormat[]> = fc.array(
  fc.record({
    channel: fc.constantFrom(...CHANNELS),
    format: fc.constantFrom(...CONTENT_FORMATS),
  }),
  { minLength: 1, maxLength: 12 },
);

// Two ordered epoch millis -> a [from, to] period (from <= to).
const periodArb = fc
  .tuple(
    fc.integer({ min: 1_577_836_800_000, max: 1_893_456_000_000 }), // 2020..2030
    fc.integer({ min: 0, max: 90 * 86_400_000 }), // span up to 90 days
  )
  .map(([fromMs, span]) => ({ from: new Date(fromMs), to: new Date(fromMs + span) }));

// ---- Property 1: plan item distribution -------------------------------------

describe('marketing-planning distribution', () => {
  // Feature: marketing-autopilot, Property 1: plan item distribution
  it('Property 1: distributePlanItems is deterministic, matrix-bound, trend-tied, date-bounded', () => {
    fc.assert(
      fc.property(trendsArb, matrixArb, periodArb, objectiveArb, (trends, matrix, period, objective) => {
        const a = distributePlanItems(trends, matrix, period, objective);
        const b = distributePlanItems(trends, matrix, period, objective);

        // Deterministic: identical inputs -> identical output.
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));

        // One spec per matrix slot.
        expect(a).toHaveLength(matrix.length);

        const channelSet = new Set<string>(CHANNELS);
        const formatSet = new Set<string>(CONTENT_FORMATS);
        const trendIds = new Set(trends.map((t) => t.id ?? null));

        const fromMs = period.from.getTime();
        const toMs = period.to.getTime();

        a.forEach((item, i) => {
          // channel/format come from the matrix slot at this position.
          expect(item.channel).toBe(matrix[i].channel);
          expect(item.format).toBe(matrix[i].format);
          expect(channelSet.has(item.channel)).toBe(true);
          expect(formatSet.has(item.format)).toBe(true);

          // trendId is one of the input trends' ids (or null when its trend had none).
          expect(trendIds.has(item.trendId)).toBe(true);

          // orderIndex matches position; objective propagates.
          expect(item.orderIndex).toBe(i);
          expect(item.objective).toBe(objective);

          // targetDate within [from, to].
          const t = item.targetDate.getTime();
          expect(t).toBeGreaterThanOrEqual(fromMs);
          expect(t).toBeLessThanOrEqual(toMs);
        });

        // When count > 1, first item lands on `from` and last on `to`.
        if (a.length > 1) {
          expect(a[0].targetDate.getTime()).toBe(fromMs);
          expect(a[a.length - 1].targetDate.getTime()).toBe(toMs);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: marketing-autopilot, Property 2: channel/format matrix validity
  it('Property 2: defaultChannelFormatMatrix is non-empty, deterministic, valid channels+formats', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const m1 = defaultChannelFormatMatrix();
        const m2 = defaultChannelFormatMatrix();

        // Deterministic.
        expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
        // Non-empty.
        expect(m1.length).toBeGreaterThan(0);

        const channelSet = new Set<string>(CHANNELS);
        const formatSet = new Set<string>(CONTENT_FORMATS);
        for (const pair of m1) {
          expect(channelSet.has(pair.channel)).toBe(true);
          expect(formatSet.has(pair.format)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---- Unit tests (fake Prisma) -----------------------------------------------

interface StoredPlan {
  id: string;
  market: string;
  status: string;
  [k: string]: unknown;
}

/**
 * Minimal Prisma fake for ContentPlanner. `adoptedTopics`/`list` resolve to
 * empty TrendSignal sets so generatePlan falls through to heuristic seeds;
 * AiPromptContext is empty (cold start). Captures created plans + item data.
 */
function fakePlannerPrisma(opts?: { plan?: StoredPlan | null; item?: Record<string, unknown> | null }): {
  prisma: PrismaClient;
  createdPlans: Array<Record<string, unknown>>;
  planUpdates: Array<{ id: string; status: string }>;
} {
  const createdPlans: Array<Record<string, unknown>> = [];
  const planUpdates: Array<{ id: string; status: string }> = [];

  const prisma = {
    trendSignal: {
      findMany: async () => [],
    },
    aiPromptContext: {
      findFirst: async () => null,
    },
    contentPlan: {
      create: async (args: { data: Record<string, unknown>; include?: unknown }) => {
        createdPlans.push(args.data);
        const itemsCreate =
          ((args.data.items as { create?: Array<Record<string, unknown>> })?.create) ?? [];
        return {
          id: 'plan-1',
          ...args.data,
          items: itemsCreate.map((it, i) => ({ id: `item-${i}`, planId: 'plan-1', ...it })),
        };
      },
      findUnique: async () => opts?.plan ?? null,
      update: async (args: { where: { id: string }; data: { status: string } }) => {
        planUpdates.push({ id: args.where.id, status: args.data.status });
        return { id: args.where.id, ...args.data };
      },
    },
    contentPlanItem: {
      findUnique: async () => opts?.item ?? null,
      findMany: async () => [],
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: args.where.id,
        ...args.data,
      }),
    },
  } as unknown as PrismaClient;

  return { prisma, createdPlans, planUpdates };
}

async function captureStatus(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof AppError) return err.status;
    throw err;
  }
}

describe('marketing-planning ContentPlanner (fake prisma)', () => {
  it('generatePlan with no adopted/discovered trends and no Gemini still creates a DRAFT plan with >=1 item', async () => {
    const { prisma, createdPlans } = fakePlannerPrisma();
    const planner = new ContentPlanner(prisma); // NO gemini

    const plan = await planner.generatePlan({
      market: 'JAPAN',
      objective: 'Lead',
      periodFrom: new Date('2025-01-01T00:00:00.000Z'),
      periodTo: new Date('2025-01-31T00:00:00.000Z'),
    });

    expect(plan.status).toBe('DRAFT');
    expect(plan.items.length).toBeGreaterThanOrEqual(1);

    // The persisted plan carried items via a nested create.
    expect(createdPlans).toHaveLength(1);
    const data = createdPlans[0] as { status: string; items: { create: unknown[] } };
    expect(data.status).toBe('DRAFT');
    expect(data.items.create.length).toBeGreaterThanOrEqual(1);

    // Every item references the heuristic seeds (topic/keyword populated).
    for (const item of plan.items) {
      expect(typeof item.topic).toBe('string');
      expect(item.topic.length).toBeGreaterThan(0);
    }
  });

  it('generatePlan rejects an unknown market with 400', async () => {
    const { prisma } = fakePlannerPrisma();
    const planner = new ContentPlanner(prisma);
    const status = await captureStatus(
      planner.generatePlan({
        market: 'MARS',
        objective: 'Lead',
        periodFrom: new Date('2025-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-31T00:00:00.000Z'),
      }),
    );
    expect(status).toBe(400);
  });

  it('generatePlan rejects an invalid objective with 400', async () => {
    const { prisma } = fakePlannerPrisma();
    const planner = new ContentPlanner(prisma);
    const status = await captureStatus(
      planner.generatePlan({
        market: 'JAPAN',
        objective: 'Sell',
        periodFrom: new Date('2025-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-31T00:00:00.000Z'),
      }),
    );
    expect(status).toBe(400);
  });

  it('activate on an already-ARCHIVED plan is an illegal transition -> 409', async () => {
    const { prisma } = fakePlannerPrisma({
      plan: { id: 'plan-1', market: 'JAPAN', status: 'ARCHIVED' },
    });
    const planner = new ContentPlanner(prisma);
    const status = await captureStatus(planner.activate('plan-1'));
    expect(status).toBe(409);
  });

  it('activate on a missing plan -> 404', async () => {
    const { prisma } = fakePlannerPrisma({ plan: null });
    const planner = new ContentPlanner(prisma);
    const status = await captureStatus(planner.activate('nope'));
    expect(status).toBe(404);
  });

  it('markItem with an invalid status -> 400', async () => {
    const { prisma } = fakePlannerPrisma({
      item: { id: 'item-1', planId: 'plan-1', status: 'PLANNED' },
    });
    const planner = new ContentPlanner(prisma);
    const status = await captureStatus(planner.markItem('item-1', 'BOGUS'));
    expect(status).toBe(400);
  });

  it('markItem on a missing item -> 404', async () => {
    const { prisma } = fakePlannerPrisma({ item: null });
    const planner = new ContentPlanner(prisma);
    const status = await captureStatus(planner.markItem('nope', 'GENERATED'));
    expect(status).toBe(404);
  });
});
