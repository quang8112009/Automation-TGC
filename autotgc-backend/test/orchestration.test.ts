// Feature: agentic-orchestration
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { withRetry } from '../src/agents/retry';
import { WorkflowOrchestrator, canTransition, workflowTransition } from '../src/orchestration/orchestrator';
import type { WorkflowDefinition } from '../src/orchestration/types';
import type { AgentContext, AgentResult } from '../src/agents/agent';
import { InMemoryEventBus } from '../src/infra/events';
import type { DomainEvent } from '../src/infra/events';

// --- Test doubles -----------------------------------------------------------

/** Deterministic incrementing clock. */
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

/**
 * Minimal in-memory Prisma stand-in covering exactly the workflowRun /
 * workflowStep operations the orchestrator uses.
 */
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

  // Cast through unknown: this fake implements only the surface the orchestrator touches.
  return { workflowRun, workflowStep } as unknown as import('@prisma/client').PrismaClient;
}

/** Collect every event published on the 'workflow' topic. */
function captureEvents(bus: InMemoryEventBus): DomainEvent[] {
  const events: DomainEvent[] = [];
  bus.subscribe((e) => {
    if (e.topic === 'workflow') events.push(e);
  });
  return events;
}

/** Build an in-memory workflow definition from simple step specs. */
function buildDefinition(
  type: string,
  specs: Array<{ name: string; result?: AgentResult; throws?: boolean; requiresApproval?: boolean }>,
): WorkflowDefinition {
  return {
    type,
    steps: specs.map((spec) => ({
      name: spec.name,
      requiresApproval: spec.requiresApproval,
      run: async (_ctx: AgentContext): Promise<AgentResult> => {
        if (spec.throws) throw new Error(`boom:${spec.name}`);
        return spec.result ?? { ok: true, output: { [`${spec.name}_done`]: true } };
      },
    })),
  };
}

// --- withRetry --------------------------------------------------------------

describe('agentic-orchestration: withRetry', () => {
  it('succeeds after N-1 failures with injected sleep (no real timers)', async () => {
    const noopSleep = async (): Promise<void> => undefined;
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 500 },
      noopSleep,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('uses exponential backoff delays (base * 2^i) between attempts', async () => {
    const delays: number[] = [];
    const recordSleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('always');
        },
        { attempts: 4, baseDelayMs: 100 },
        recordSleep,
      ),
    ).rejects.toThrow('always');
    // 4 attempts -> 3 inter-attempt sleeps at 100, 200, 400.
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it('Property: resolves iff failures < attempts (deterministic sleep)', async () => {
    const noopSleep = async (): Promise<void> => undefined;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }), // attempts
        fc.integer({ min: 0, max: 8 }), // number of leading failures
        async (attempts, failures) => {
          let calls = 0;
          const run = withRetry(
            async () => {
              calls += 1;
              if (calls <= failures) throw new Error('fail');
              return 'value';
            },
            { attempts, baseDelayMs: 1 },
            noopSleep,
          );
          if (failures < attempts) {
            await expect(run).resolves.toBe('value');
            expect(calls).toBe(failures + 1);
          } else {
            await expect(run).rejects.toThrow('fail');
            expect(calls).toBe(attempts);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- transition guard -------------------------------------------------------

describe('agentic-orchestration: status transitions', () => {
  it('guards legal vs illegal WorkflowStatus moves', () => {
    expect(canTransition('PENDING', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
    expect(canTransition('RUNNING', 'WAITING_APPROVAL')).toBe(true);
    expect(canTransition('WAITING_APPROVAL', 'RUNNING')).toBe(true);
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransition('PENDING', 'PENDING')).toBe(false);
    expect(workflowTransition('COMPLETED', 'RUNNING')).toEqual({ ok: false, code: 'ILLEGAL_TRANSITION' });
  });
});

// --- orchestrator sequencing ------------------------------------------------

describe('agentic-orchestration: orchestrator sequencing', () => {
  it('runs a 3-step definition to COMPLETED and merges step outputs into context', async () => {
    const prisma = makeFakePrisma();
    const bus = new InMemoryEventBus();
    const events = captureEvents(bus);
    const orchestrator = new WorkflowOrchestrator(prisma, bus, fakeClock(), { sleep: async () => undefined });

    const def = buildDefinition('three_step', [
      { name: 'a', result: { ok: true, output: { a: 1 } } },
      { name: 'b', result: { ok: true, output: { b: 2 } } },
      { name: 'c', result: { ok: true, output: { c: 3 } } },
    ]);

    const run = await orchestrator.start(def, { seed: true }, 'user-1');
    expect(run.status).toBe('COMPLETED');
    expect(run.steps.map((s) => s.status)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(run.context).toMatchObject({ seed: true, a: 1, b: 2, c: 3 });

    const types = events.map((e) => e.type);
    expect(types).toContain('started');
    expect(types.filter((t) => t === 'step_completed')).toHaveLength(3);
    expect(types).toContain('status_changed');
  });

  it('marks the run FAILED when a step fails (and stops subsequent steps)', async () => {
    const prisma = makeFakePrisma();
    const bus = new InMemoryEventBus();
    const events = captureEvents(bus);
    const orchestrator = new WorkflowOrchestrator(prisma, bus, fakeClock(), { sleep: async () => undefined });

    const def = buildDefinition('failing', [
      { name: 'ok1', result: { ok: true, output: { ok1: true } } },
      { name: 'bad', result: { ok: false, error: 'nope' } },
      { name: 'never', result: { ok: true } },
    ]);

    const run = await orchestrator.start(def, {});
    expect(run.status).toBe('FAILED');
    expect(run.error).toBe('nope');
    expect(run.steps.map((s) => s.status)).toEqual(['DONE', 'FAILED', 'PENDING']);
    expect(events.map((e) => e.type)).toContain('failed');
  });

  it('marks the run FAILED when a step throws even after retries', async () => {
    const prisma = makeFakePrisma();
    const bus = new InMemoryEventBus();
    const orchestrator = new WorkflowOrchestrator(prisma, bus, fakeClock(), {
      retry: { attempts: 2, baseDelayMs: 1 },
      sleep: async () => undefined,
    });

    const def = buildDefinition('throwing', [{ name: 'kaboom', throws: true }]);
    const run = await orchestrator.start(def, {});
    expect(run.status).toBe('FAILED');
    expect(run.steps[0].status).toBe('FAILED');
    expect(run.steps[0].error).toContain('boom:kaboom');
  });

  it('pauses at an approval step (WAITING_APPROVAL) then resume -> COMPLETED', async () => {
    const prisma = makeFakePrisma();
    const bus = new InMemoryEventBus();
    const events = captureEvents(bus);
    const orchestrator = new WorkflowOrchestrator(prisma, bus, fakeClock(), { sleep: async () => undefined });

    const def = buildDefinition('approval', [
      { name: 'generate', result: { ok: true, output: { draftId: 'd1' } } },
      { name: 'await_review', requiresApproval: true },
      { name: 'schedule', result: { ok: true, output: { scheduled: true } } },
    ]);

    const paused = await orchestrator.start(def, {});
    expect(paused.status).toBe('WAITING_APPROVAL');
    expect(paused.currentStep).toBe('await_review');
    expect(paused.steps.map((s) => s.status)).toEqual(['DONE', 'PENDING', 'PENDING']);
    expect(events.map((e) => e.type)).toContain('awaiting_approval');

    const resumed = await orchestrator.resume(paused.id);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.steps.map((s) => s.status)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(resumed.context).toMatchObject({ draftId: 'd1', scheduled: true });
    expect(events.map((e) => e.type)).toContain('resumed');
  });

  it('resume on a non-paused run throws a conflict', async () => {
    const prisma = makeFakePrisma();
    const bus = new InMemoryEventBus();
    const orchestrator = new WorkflowOrchestrator(prisma, bus, fakeClock(), { sleep: async () => undefined });

    const def = buildDefinition('simple', [{ name: 'a', result: { ok: true } }]);
    const run = await orchestrator.start(def, {});
    expect(run.status).toBe('COMPLETED');
    await expect(orchestrator.resume(run.id)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_AWAITING_APPROVAL' });
  });

  it('cancel marks the run CANCELLED and skips remaining PENDING steps', async () => {
    const prisma = makeFakePrisma();
    const bus = new InMemoryEventBus();
    const events = captureEvents(bus);
    const orchestrator = new WorkflowOrchestrator(prisma, bus, fakeClock(), { sleep: async () => undefined });

    const def = buildDefinition('cancellable', [
      { name: 'gen', result: { ok: true, output: { draftId: 'd1' } } },
      { name: 'await_review', requiresApproval: true },
      { name: 'schedule', result: { ok: true } },
    ]);

    const paused = await orchestrator.start(def, {});
    expect(paused.status).toBe('WAITING_APPROVAL');

    const cancelled = await orchestrator.cancel(paused.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.steps.map((s) => s.status)).toEqual(['DONE', 'SKIPPED', 'SKIPPED']);
    expect(events.map((e) => e.type)).toContain('cancelled');
  });
});
