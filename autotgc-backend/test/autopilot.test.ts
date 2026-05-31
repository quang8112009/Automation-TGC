// Feature: marketing-autopilot
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { InMemoryEventBus } from '../src/infra/events';
import { AppError } from '../src/infra/errors';
import { ASSET_KINDS, isAssetKind } from '../src/marketing/assets/assetKinds';
import { CONTENT_FORMATS } from '../src/marketing/content/formats';
import {
  assetKindForFormat,
  performanceWeight,
  sequenceForPerformance,
  channelToPlatform,
} from '../src/marketing/autopilot/autopilotWorkflow';
import type { AutopilotDeps } from '../src/marketing/autopilot/autopilotWorkflow';
import { AutopilotService } from '../src/marketing/autopilot/autopilotService';

// --- Deterministic clock + in-memory Prisma stand-in -----------------------
// Reuses the exact orchestration.test.ts doubles: a deterministic incrementing
// clock + a minimal Prisma covering only the workflowRun / workflowStep surface
// the WorkflowOrchestrator touches. The marketing services are stubbed, so no
// real Gemini / DB is needed.

function fakeClock(start = 0) {
  let t = start;
  return { now: () => new Date(t++) };
}

interface FakeStep {
  id: string;
  runId: string;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  orderIndex: number;
}

interface FakeRun {
  id: string;
  type: string;
  status: string;
  currentStep: string | null;
  context: unknown;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma() {
  const runs = new Map<string, FakeRun>();
  const steps = new Map<string, FakeStep>();
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;

  function stepsForRun(runId: string): FakeStep[] {
    return [...steps.values()]
      .filter((s) => s.runId === runId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
  }
  function runWithSteps(runId: string): (FakeRun & { steps: FakeStep[] }) | null {
    const run = runs.get(runId);
    if (!run) return null;
    return { ...run, steps: stepsForRun(runId).map((s) => ({ ...s })) };
  }

  const workflowRun = {
    async create(args: { data: Record<string, unknown>; include?: unknown }) {
      const runId = id('run');
      const data = args.data;
      const run: FakeRun = {
        id: runId,
        type: String(data.type),
        status: String(data.status ?? 'PENDING'),
        currentStep: (data.currentStep as string | null) ?? null,
        context: data.context ?? {},
        error: (data.error as string | null) ?? null,
        createdBy: (data.createdBy as string | null) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      runs.set(runId, run);
      const nested = data.steps as { create?: Array<Record<string, unknown>> } | undefined;
      if (nested?.create) {
        for (const s of nested.create) {
          const stepId = id('step');
          steps.set(stepId, {
            id: stepId,
            runId,
            name: String(s.name),
            status: String(s.status ?? 'PENDING'),
            input: s.input ?? null,
            output: s.output ?? null,
            error: (s.error as string | null) ?? null,
            startedAt: null,
            finishedAt: null,
            orderIndex: Number(s.orderIndex ?? 0),
          });
        }
      }
      return runWithSteps(runId);
    },
    async findUnique(args: { where: { id: string }; include?: unknown }) {
      return runWithSteps(args.where.id);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown>; include?: unknown }) {
      const run = runs.get(args.where.id);
      if (!run) throw new Error('run not found');
      for (const [k, v] of Object.entries(args.data)) {
        (run as Record<string, unknown>)[k] = v;
      }
      run.updatedAt = new Date();
      return runWithSteps(args.where.id);
    },
  };

  const workflowStep = {
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const step = steps.get(args.where.id);
      if (!step) throw new Error('step not found');
      for (const [k, v] of Object.entries(args.data)) {
        (step as Record<string, unknown>)[k] = v;
      }
      return { ...step };
    },
    async updateMany(args: { where: { runId: string; status?: string }; data: Record<string, unknown> }) {
      let count = 0;
      for (const step of steps.values()) {
        if (step.runId !== args.where.runId) continue;
        if (args.where.status !== undefined && step.status !== args.where.status) continue;
        for (const [k, v] of Object.entries(args.data)) {
          (step as Record<string, unknown>)[k] = v;
        }
        count += 1;
      }
      return { count };
    },
  };

  return { workflowRun, workflowStep } as unknown as import('@prisma/client').PrismaClient;
}

// --- Stub marketing services ------------------------------------------------

interface StubItem {
  id: string;
  channel: string;
  format: string;
  topic: string;
  keyword: string;
  objective: string;
  targetDate: Date | null;
  status: string;
  draftId: string | null;
  market: string;
  orderIndex: number;
}

interface StubOptions {
  items: StubItem[];
  /** Formats for which multiFormatGenerator.generate throws a 502 (soft skip). */
  failFormats?: string[];
}

function makeStubDeps(opts: StubOptions) {
  const itemMap = new Map(opts.items.map((i) => [i.id, i]));
  const scheduleCalls: Array<{ draftId: string; platforms: string[] }> = [];
  let draftSeq = 0;
  let genCalls = 0;
  let assetCalls = 0;

  const trendResearch = {
    async adoptedTopics() {
      return [];
    },
    async list() {
      return [];
    },
    async research() {
      return { created: [{ id: 't1' }, { id: 't2' }], aiGenerated: false };
    },
  };

  const contentPlanner = {
    async generatePlan() {
      return { id: 'plan_1', items: opts.items.map((i) => ({ ...i })) };
    },
    async listItems() {
      return opts.items.map((i) => ({ ...(itemMap.get(i.id) as StubItem) }));
    },
    async markItem(itemId: string, status: string, draftId?: string) {
      const it = itemMap.get(itemId);
      if (it) {
        it.status = status;
        if (draftId) it.draftId = draftId;
      }
      return { ...(it as StubItem) };
    },
  };

  const multiFormatGenerator = {
    async generate(req: { format: string }) {
      genCalls += 1;
      if (opts.failFormats?.includes(req.format)) {
        throw new AppError(502, 'AI not configured', 'AI_NOT_CONFIGURED');
      }
      const id = `draft_${++draftSeq}`;
      return { draft: { id }, format: req.format, aiGenerated: true, generatedWithoutFeedback: true };
    },
  };

  const assetGenerator = {
    async generateForDraft() {
      assetCalls += 1;
      return { id: `asset_${assetCalls}` };
    },
  };

  const schedulingService = {
    async schedule(req: { draftId: string; platforms: string[] }) {
      scheduleCalls.push({ draftId: req.draftId, platforms: req.platforms });
      return { created: [{ id: `post_${scheduleCalls.length}` }], rejected: [] };
    },
  };

  const deps = {
    trendResearch,
    contentPlanner,
    multiFormatGenerator,
    assetGenerator,
    schedulingService,
  } as unknown as AutopilotDeps;

  return {
    deps,
    stats: () => ({ genCalls, assetCalls, scheduleCount: scheduleCalls.length, scheduleCalls }),
  };
}

function makeItem(over: Partial<StubItem> & { id: string }): StubItem {
  return {
    channel: 'facebook',
    format: 'FANPAGE_CAPTION',
    topic: 'topic',
    keyword: 'keyword',
    objective: 'Lead',
    targetDate: new Date('2999-01-01T00:00:00.000Z'),
    status: 'PLANNED',
    draftId: null,
    market: 'JAPAN',
    orderIndex: 0,
    ...over,
  };
}

const RUN_INPUT = {
  market: 'JAPAN',
  objective: 'Lead',
  periodFrom: '2025-01-01T00:00:00.000Z',
  periodTo: '2025-01-31T00:00:00.000Z',
  domainName: 'thanhgiang.com',
  personaIds: ['p1'],
};

function makeService(deps: AutopilotDeps) {
  const prisma = makeFakePrisma();
  const bus = new InMemoryEventBus();
  const service = new AutopilotService(prisma, bus, deps, fakeClock(), { sleep: async () => undefined });
  return { service, bus };
}

// --- Property 5: format → asset-kind mapping --------------------------------

describe('marketing-autopilot: assetKindForFormat', () => {
  it('maps every ContentFormat to a valid AssetKind (explicit totality)', () => {
    for (const fmt of CONTENT_FORMATS) {
      expect(isAssetKind(assetKindForFormat(fmt))).toBe(true);
    }
  });

  it('Property: assetKindForFormat is total over ContentFormats and returns a valid AssetKind', () => {
    // Feature: marketing-autopilot, Property 5: format to asset-kind mapping
    fc.assert(
      fc.property(fc.constantFrom(...CONTENT_FORMATS), (fmt) => {
        const kind = assetKindForFormat(fmt);
        expect(ASSET_KINDS).toContain(kind);
        expect(isAssetKind(kind)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('Property: assetKindForFormat is total over arbitrary strings (never throws, always valid)', () => {
    // Feature: marketing-autopilot, Property 5: format to asset-kind mapping
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(isAssetKind(assetKindForFormat(s))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// --- Performance-first sequencing (core principle) --------------------------

describe('marketing-autopilot: sequenceForPerformance', () => {
  it('orders the highest-leverage formats first, stable on ties', () => {
    const items = [
      makeItem({ id: 'a', format: 'CHATBOT_FAQ', orderIndex: 0 }),
      makeItem({ id: 'b', format: 'VIDEO_SCRIPT', orderIndex: 1 }),
      makeItem({ id: 'c', format: 'SEO_ARTICLE', orderIndex: 2 }),
      makeItem({ id: 'd', format: 'VIDEO_SCRIPT', orderIndex: 3 }),
    ];
    const ordered = sequenceForPerformance(items).map((i) => i.id);
    // VIDEO_SCRIPT (100) first, tie broken by orderIndex (b before d); then SEO (90); then FAQ (30).
    expect(ordered).toEqual(['b', 'd', 'c', 'a']);
    expect(performanceWeight('VIDEO_SCRIPT')).toBeGreaterThan(performanceWeight('CHATBOT_FAQ'));
  });
});

// --- Review gate pause + approve --------------------------------------------

describe('marketing-autopilot: review gate', () => {
  it('PAUSES at review_gate (WAITING_APPROVAL) when requireApproval=true, then approve() proceeds to schedule + summary', async () => {
    const items = [
      makeItem({ id: 'i1', channel: 'facebook', format: 'FANPAGE_CAPTION', orderIndex: 0 }),
      makeItem({ id: 'i2', channel: 'tiktok', format: 'VIDEO_SCRIPT', orderIndex: 1 }),
    ];
    const { deps, stats } = makeStubDeps({ items });
    const { service } = makeService(deps);

    const paused = await service.run({ ...RUN_INPUT, requireApproval: true }, 'admin-1');

    // Paused exactly at the review gate, AFTER generation, BEFORE scheduling.
    expect(paused.status).toBe('WAITING_APPROVAL');
    expect(paused.currentStep).toBe('review_gate');
    expect(paused.steps.map((s) => s.name)).toEqual([
      'research',
      'plan',
      'generate',
      'review_gate',
      'schedule',
      'summary',
    ]);
    expect(paused.steps.map((s) => s.status)).toEqual([
      'DONE',
      'DONE',
      'DONE',
      'PENDING',
      'PENDING',
      'PENDING',
    ]);
    // Generation happened (2 drafts + 2 best-effort assets); nothing scheduled yet.
    expect(stats().genCalls).toBe(2);
    expect(stats().assetCalls).toBe(2);
    expect(stats().scheduleCount).toBe(0);
    expect(paused.context).toMatchObject({ generated: 2, skipped: 0 });

    // Approve -> resume past the gate -> schedule + summary -> COMPLETED.
    const done = await service.approve(paused.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.steps.map((s) => s.status)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'DONE', 'DONE']);
    expect(stats().scheduleCount).toBe(2);
    expect(done.context).toMatchObject({ generated: 2, scheduled: 2 });
    const summary = (done.context as Record<string, unknown>).summary as Record<string, unknown>;
    expect(summary).toMatchObject({ market: 'JAPAN', planId: 'plan_1', generated: 2, scheduled: 2 });
  });
});

// --- 502 soft-skip resilience -----------------------------------------------

describe('marketing-autopilot: generate soft-skip on 502', () => {
  it('treats a multiFormatGenerator 502 as a per-item soft skip (run advances, skip recorded, no hard fail)', async () => {
    const items = [
      makeItem({ id: 'v', channel: 'tiktok', format: 'VIDEO_SCRIPT', orderIndex: 0 }),
      makeItem({ id: 's', channel: 'website', format: 'SEO_ARTICLE', orderIndex: 1 }),
      makeItem({ id: 'e', channel: 'email', format: 'EMAIL', orderIndex: 2 }),
    ];
    // SEO_ARTICLE generation throws 502 AI_NOT_CONFIGURED -> must be soft-skipped.
    const { deps, stats } = makeStubDeps({ items, failFormats: ['SEO_ARTICLE'] });
    const { service } = makeService(deps);

    // requireApproval=false so the run drives all the way to COMPLETED and we can
    // prove the generate step never hard-failed despite the 502.
    const run = await service.run({ ...RUN_INPUT, requireApproval: false }, 'admin-1');

    expect(run.status).toBe('COMPLETED');
    const generateStep = run.steps.find((s) => s.name === 'generate');
    expect(generateStep?.status).toBe('DONE'); // NOT FAILED — soft skip worked.

    // 2 succeeded (VIDEO_SCRIPT, EMAIL), 1 soft-skipped (SEO_ARTICLE).
    expect(run.context).toMatchObject({ generated: 2, skipped: 1 });
    const skippedItems = (run.context as Record<string, unknown>).skippedItems as Array<{
      format: string;
      reason: string;
    }>;
    expect(skippedItems).toHaveLength(1);
    expect(skippedItems[0].format).toBe('SEO_ARTICLE');
    expect(skippedItems[0].reason).toContain('AI_NOT_CONFIGURED');

    // tiktok (draft platform) scheduled; email is a non-draft channel -> not scheduled.
    expect(stats().scheduleCount).toBe(1);
    expect(channelToPlatform('email')).toBeNull();
    expect(run.context).toMatchObject({ scheduled: 1, skippedChannel: 1 });
  });
});

// --- Validation -------------------------------------------------------------

describe('marketing-autopilot: run validation', () => {
  it('rejects an unknown market / bad objective / invalid dates with 400', async () => {
    const { deps } = makeStubDeps({ items: [] });
    const { service } = makeService(deps);

    await expect(service.run({ ...RUN_INPUT, market: 'MARS' })).rejects.toMatchObject({ status: 400 });
    await expect(service.run({ ...RUN_INPUT, objective: 'Sell' })).rejects.toMatchObject({ status: 400 });
    await expect(service.run({ ...RUN_INPUT, periodFrom: 'not-a-date' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.run({ ...RUN_INPUT, periodFrom: '2025-02-01T00:00:00.000Z', periodTo: '2025-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
