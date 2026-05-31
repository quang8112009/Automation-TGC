/**
 * WorkflowOrchestrator (Agentic Orchestration Layer).
 *
 * Drives a persisted, multi-step agentic saga over the WorkflowRun /
 * WorkflowStep tables. Each transition is persisted and broadcast on the
 * 'workflow' event topic so the real-time layer can stream progress. Status
 * changes go through a guarded transition function that returns conflict
 * semantics for illegal moves (mirroring the project's *Machine convention).
 *
 * Lifecycle:
 *   start  -> creates run (PENDING -> RUNNING) + step rows, then advances.
 *   runNext-> runs the next PENDING step (retry-wrapped); on success merges the
 *             output into the run context and continues; a step that requires
 *             approval pauses the run (WAITING_APPROVAL) until resume().
 *   resume -> approves the pending gate, returns to RUNNING, and advances.
 *   cancel -> terminal CANCELLED (remaining steps SKIPPED).
 *
 * Because runNext/resume receive only a runId, definitions (which carry the
 * step closures bound to services) are registered in-memory and resolved by
 * WorkflowRun.type.
 */
import type { Prisma, PrismaClient, WorkflowRun, WorkflowStep, WorkflowStatus } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import { ConflictError, NotFoundError } from '../infra/errors';
import type { EventBus } from '../infra/events';
import type { AgentContext, AgentResult } from '../agents/agent';
import { isRecord } from '../agents/agent';
import { withRetry } from '../agents/retry';
import type { RetryOptions, SleepFn } from '../agents/retry';
import type { StepDefinition, WorkflowDefinition } from './types';

/** WorkflowStep.status is a plain string column; model the lifecycle locally. */
export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** A run with its ordered steps eagerly loaded. */
export type WorkflowRunWithSteps = WorkflowRun & { steps: WorkflowStep[] };

/** Legal WorkflowStatus transitions (guarded; everything else is a conflict). */
const VALID_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['RUNNING', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export type TransitionResult = { ok: true } | { ok: false; code: 'ILLEGAL_TRANSITION' };

/** Pure guard: is `from -> to` a legal WorkflowStatus move? */
export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

/** Pure guarded transition with conflict semantics for the orchestrator. */
export function workflowTransition(from: WorkflowStatus, to: WorkflowStatus): TransitionResult {
  return canTransition(from, to) ? { ok: true } : { ok: false, code: 'ILLEGAL_TRANSITION' };
}

export interface OrchestratorOptions {
  /** Retry policy applied to each step's run(). */
  retry?: RetryOptions;
  /** Injectable sleep for deterministic retry timing in tests. */
  sleep?: SleepFn;
}

export class WorkflowOrchestrator {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly retry: RetryOptions;
  private readonly sleep: SleepFn | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventBus: EventBus,
    private readonly clock: Clock = systemClock,
    options: OrchestratorOptions = {},
    definitions: WorkflowDefinition[] = [],
  ) {
    this.retry = options.retry ?? {};
    this.sleep = options.sleep;
    for (const def of definitions) this.registerDefinition(def);
  }

  /** Register (or replace) a workflow definition so runNext/resume can resolve it by type. */
  registerDefinition(definition: WorkflowDefinition): void {
    this.definitions.set(definition.type, definition);
  }

  /**
   * Create a run for `definition`, seed its step rows, transition PENDING ->
   * RUNNING, publish 'started', then advance through the steps.
   */
  async start(
    definition: WorkflowDefinition,
    initialContext: Record<string, unknown> = {},
    createdBy?: string,
  ): Promise<WorkflowRunWithSteps> {
    this.registerDefinition(definition);

    const created = await this.prisma.workflowRun.create({
      data: {
        type: definition.type,
        status: 'RUNNING',
        currentStep: null,
        context: toJson(initialContext),
        createdBy: createdBy ?? null,
        steps: {
          create: definition.steps.map((step, orderIndex) => ({
            name: step.name,
            status: 'PENDING',
            orderIndex,
          })),
        },
      },
      include: { steps: orderedSteps },
    });

    await this.publish('started', { runId: created.id, type: created.type });
    return this.runNext(created.id);
  }

  /**
   * Advance a RUNNING run: execute consecutive PENDING steps until the run
   * completes, fails, or pauses for approval. Idempotent for non-RUNNING runs.
   */
  async runNext(runId: string): Promise<WorkflowRunWithSteps> {
    // Loop so a single call drives the run as far as it can go.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const run = await this.loadRun(runId);

      // Only RUNNING runs advance; terminal/paused/pending runs are returned as-is.
      if (run.status !== 'RUNNING') {
        return run;
      }

      const nextStep = run.steps.find((s) => s.status === 'PENDING');
      if (!nextStep) {
        // No work left -> the run is complete.
        return this.transition(run, 'COMPLETED', { currentStep: null });
      }

      const definition = this.definitions.get(run.type);
      const stepDef = definition?.steps.find((s) => s.name === nextStep.name);
      if (!stepDef) {
        return this.failStep(run, nextStep, `No definition registered for step ${nextStep.name}`);
      }

      // Approval gate: pause BEFORE running a step that requires human approval,
      // unless the gate has already been opened (resume sets step.input.approved).
      if (stepDef.requiresApproval && !isStepApproved(nextStep)) {
        await this.markStepStatus(nextStep.id, 'PENDING', { startedAt: null });
        const paused = await this.transition(run, 'WAITING_APPROVAL', { currentStep: nextStep.name });
        await this.publish('awaiting_approval', { runId: run.id, step: nextStep.name });
        return paused;
      }

      const outcome = await this.executeStep(run, nextStep, stepDef);
      if (outcome === 'stop') {
        return this.loadRun(runId);
      }
      // outcome === 'continue' -> loop to the next PENDING step.
    }
  }

  /**
   * Resume a WAITING_APPROVAL run after human approval: open the pending gate,
   * transition back to RUNNING, publish 'resumed', and advance.
   */
  async resume(runId: string): Promise<WorkflowRunWithSteps> {
    const run = await this.loadRun(runId);
    if (run.status !== 'WAITING_APPROVAL') {
      throw new ConflictError(
        `Run ${runId} is not awaiting approval (status ${run.status})`,
        'WORKFLOW_NOT_AWAITING_APPROVAL',
      );
    }

    const gateStep =
      run.steps.find((s) => s.status === 'PENDING' && s.name === run.currentStep) ??
      run.steps.find((s) => s.status === 'PENDING');
    if (gateStep) {
      await this.markStepStatus(gateStep.id, 'PENDING', {
        input: toJson({ ...asRecord(gateStep.input), approved: true, approvedAt: this.nowIso() }),
      });
    }

    await this.transition(run, 'RUNNING', {});
    await this.publish('resumed', { runId: run.id, step: gateStep?.name ?? null });
    return this.runNext(runId);
  }

  /** Cancel a non-terminal run; remaining PENDING steps are marked SKIPPED. */
  async cancel(runId: string): Promise<WorkflowRunWithSteps> {
    const run = await this.loadRun(runId);
    const guard = workflowTransition(run.status, 'CANCELLED');
    if (!guard.ok) {
      throw new ConflictError(
        `Run ${runId} cannot be cancelled from status ${run.status}`,
        'WORKFLOW_ILLEGAL_TRANSITION',
      );
    }
    await this.prisma.workflowStep.updateMany({
      where: { runId, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
    const cancelled = await this.transition(run, 'CANCELLED', { currentStep: null });
    await this.publish('cancelled', { runId: run.id });
    return cancelled;
  }

  /** Fetch a run with its ordered steps (404 when missing). */
  async getRun(runId: string): Promise<WorkflowRunWithSteps> {
    return this.loadRun(runId);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Run a single step: mark RUNNING, invoke the agent (retry-wrapped), then on
   * success merge output into the run context + mark DONE ('continue'); on a
   * structured/transient failure mark the step + run FAILED ('stop').
   */
  private async executeStep(
    run: WorkflowRunWithSteps,
    step: WorkflowStep,
    stepDef: StepDefinition,
  ): Promise<'continue' | 'stop'> {
    await this.markStepStatus(step.id, 'RUNNING', { startedAt: this.now(), error: null });
    await this.prisma.workflowRun.update({ where: { id: run.id }, data: { currentStep: step.name } });

    const ctx: AgentContext = { runId: run.id, variables: asRecord(run.context) };

    let result: AgentResult;
    try {
      result = await withRetry(() => stepDef.run(ctx), this.retry, this.sleep);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failStep(run, step, message);
      return 'stop';
    }

    if (!result.ok) {
      await this.failStep(run, step, result.error ?? 'Step failed');
      return 'stop';
    }

    const output = result.output ?? {};
    const mergedContext = { ...asRecord(run.context), ...output };
    await this.prisma.workflowStep.update({
      where: { id: step.id },
      data: { status: 'DONE', output: toJson(output), finishedAt: this.now() },
    });
    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: { context: toJson(mergedContext) },
    });
    await this.publish('step_completed', { runId: run.id, step: step.name, output });
    return 'continue';
  }

  /** Mark a step FAILED and fail the whole run (RUNNING -> FAILED). */
  private async failStep(
    run: WorkflowRunWithSteps,
    step: WorkflowStep,
    error: string,
  ): Promise<WorkflowRunWithSteps> {
    await this.prisma.workflowStep.update({
      where: { id: step.id },
      data: { status: 'FAILED', error, finishedAt: this.now() },
    });
    const failed = await this.transition(run, 'FAILED', { currentStep: step.name, error });
    await this.publish('failed', { runId: run.id, step: step.name, error });
    return failed;
  }

  /** Persist a guarded status transition; throws ConflictError on illegal moves. */
  private async transition(
    run: WorkflowRun,
    to: WorkflowStatus,
    extra: { currentStep?: string | null; error?: string },
  ): Promise<WorkflowRunWithSteps> {
    const guard = workflowTransition(run.status, to);
    if (!guard.ok) {
      throw new ConflictError(
        `Illegal workflow transition ${run.status} -> ${to}`,
        'WORKFLOW_ILLEGAL_TRANSITION',
      );
    }
    const data: Prisma.WorkflowRunUpdateInput = { status: to };
    if ('currentStep' in extra) data.currentStep = extra.currentStep ?? null;
    if (extra.error !== undefined) data.error = extra.error;

    const updated = await this.prisma.workflowRun.update({
      where: { id: run.id },
      data,
      include: { steps: orderedSteps },
    });
    await this.publish('status_changed', { runId: run.id, from: run.status, to });
    return updated;
  }

  private async markStepStatus(
    stepId: string,
    status: StepStatus,
    extra: Prisma.WorkflowStepUpdateInput = {},
  ): Promise<void> {
    await this.prisma.workflowStep.update({
      where: { id: stepId },
      data: { status, ...extra },
    });
  }

  private async loadRun(runId: string): Promise<WorkflowRunWithSteps> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { steps: orderedSteps },
    });
    if (!run) {
      throw new NotFoundError(`Workflow run ${runId} not found`, 'WORKFLOW_RUN_NOT_FOUND');
    }
    return run;
  }

  private async publish(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.eventBus.publish({ topic: 'workflow', type, payload });
  }

  private now(): Date {
    return this.clock.now();
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

/** Stable step ordering for every read. */
const orderedSteps = { orderBy: { orderIndex: 'asc' } } as const;

/** True when a step's input carries an `approved: true` flag (resume opened the gate). */
function isStepApproved(step: WorkflowStep): boolean {
  const input = step.input;
  return isRecord(input) && input.approved === true;
}

/** Coerce a Prisma Json value into a plain record (empty for non-objects/null). */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Narrow a record to Prisma's JSON input type at the persistence boundary. */
function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
