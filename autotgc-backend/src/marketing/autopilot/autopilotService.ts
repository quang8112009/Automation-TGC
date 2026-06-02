/**
 * Autopilot_Service — thin orchestration service that starts/advances the
 * marketing autopilot WorkflowDefinition on the EXISTING WorkflowOrchestrator
 * saga engine (customer: Thanh Giang — Vietnamese labor-export / XKLĐ).
 *
 * It does NOT implement a saga engine: it constructs a WorkflowOrchestrator,
 * registers `buildAutopilotWorkflow(deps)`, validates the run request (400s),
 * and delegates start / resume (approve) / cancel / get to the orchestrator.
 *
 * Per the product's review-mode principle and the core "performance not volume"
 * rule, a run started with requireApproval (default true) PAUSES at the
 * `review_gate` step (WAITING_APPROVAL) so a human reviews the generated drafts
 * before anything is scheduled. `approve(runId)` resumes the run.
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../auth/jwt';
import { ValidationError } from '../../infra/errors';
import type { EventBus } from '../../infra/events';
import { isMarket } from '../markets';
import { WorkflowOrchestrator } from '../../orchestration/orchestrator';
import type { OrchestratorOptions, WorkflowRunWithSteps } from '../../orchestration/orchestrator';
import type { WorkflowDefinition } from '../../orchestration/types';
import { AUTOPILOT_TYPE, buildAutopilotWorkflow } from './autopilotWorkflow';
import type { AutopilotDeps } from './autopilotWorkflow';

/** Allowed content objectives (mirror the planner + generator vocabulary). */
const OBJECTIVES: ReadonlySet<string> = new Set(['Lead', 'View', 'Follow']);

/** Validated run request the autopilot works with. */
export interface AutopilotRunInput {
  market: string;
  objective: string;
  periodFrom: string;
  periodTo: string;
  channels?: string[];
  /** Extra context passed to generation (domain + personas). */
  domainName?: string;
  personaIds?: string[];
  /** When false, the run does not pause at the review gate (still APPROVED-only schedule). */
  requireApproval?: boolean;
}

export class AutopilotService {
  private readonly orchestrator: WorkflowOrchestrator;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventBus: EventBus,
    private readonly deps: AutopilotDeps,
    clock?: Clock,
    options: OrchestratorOptions = {},
  ) {
    this.orchestrator = new WorkflowOrchestrator(prisma, eventBus, clock, options);
    // Pre-register the definition so runNext/resume can resolve it by type.
    this.orchestrator.registerDefinition(this.definition());
  }

  /** Build the autopilot definition from the injected services. */
  private definition(): WorkflowDefinition {
    return buildAutopilotWorkflow(this.deps);
  }

  /**
   * Validate the request (400s) and start the autopilot run. The run will pause
   * at `review_gate` (WAITING_APPROVAL) when requireApproval is true.
   */
  async run(input: AutopilotRunInput, createdBy?: string): Promise<WorkflowRunWithSteps> {
    if (!isMarket(input.market)) {
      throw new ValidationError('Unknown market', 'AUTOPILOT_MARKET_INVALID');
    }
    if (!input.objective || !OBJECTIVES.has(input.objective)) {
      throw new ValidationError('Objective must be one of Lead, View, Follow', 'AUTOPILOT_OBJECTIVE_INVALID');
    }
    const from = coerceDate(input.periodFrom, 'AUTOPILOT_PERIOD_FROM_INVALID');
    const to = coerceDate(input.periodTo, 'AUTOPILOT_PERIOD_TO_INVALID');
    if (to.getTime() < from.getTime()) {
      throw new ValidationError('periodTo must be on or after periodFrom', 'AUTOPILOT_PERIOD_RANGE_INVALID');
    }

    // The generate step requires a domain + at least one persona before any AI
    // call (MultiFormatGenerator.validate). Without them EVERY item would be
    // soft-skipped and the run would still COMPLETE with generated=0 — a
    // misleading "success". Fail fast (400) so the operator fixes the input.
    const domainName =
      typeof input.domainName === 'string' ? input.domainName.trim() : '';
    if (domainName.length === 0) {
      throw new ValidationError('domainName is required', 'AUTOPILOT_DOMAIN_REQUIRED');
    }
    const personaIds = Array.isArray(input.personaIds)
      ? input.personaIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    if (personaIds.length === 0) {
      throw new ValidationError('At least one personaId is required', 'AUTOPILOT_PERSONA_REQUIRED');
    }

    const requireApproval = input.requireApproval ?? this.deps.requireApproval ?? true;

    const initialContext: Record<string, unknown> = {
      market: input.market,
      objective: input.objective,
      periodFrom: from.toISOString(),
      periodTo: to.toISOString(),
      requireApproval,
    };
    if (Array.isArray(input.channels) && input.channels.length > 0) {
      initialContext.channels = input.channels.filter((c) => typeof c === 'string' && c.trim().length > 0);
    }
    initialContext.domainName = domainName;
    initialContext.personaIds = personaIds;
    if (createdBy && createdBy.trim().length > 0) {
      initialContext.createdBy = createdBy.trim();
    }

    // Build a definition honoring this run's requireApproval choice.
    const definition = buildAutopilotWorkflow({ ...this.deps, requireApproval });
    return this.orchestrator.start(definition, initialContext, createdBy);
  }

  /** Approve a paused run: resume past the review gate to schedule + summary. */
  async approve(runId: string): Promise<WorkflowRunWithSteps> {
    return this.orchestrator.resume(runId);
  }

  /** Cancel a non-terminal run. */
  async cancel(runId: string): Promise<WorkflowRunWithSteps> {
    return this.orchestrator.cancel(runId);
  }

  /** Fetch a run with its ordered steps. */
  async get(runId: string): Promise<WorkflowRunWithSteps> {
    return this.orchestrator.getRun(runId);
  }
}

/** Re-export the type discriminator for callers wiring routes/tests. */
export { AUTOPILOT_TYPE };

/** Coerce a Date | ISO string to a valid Date or throw a 400. */
function coerceDate(value: string, code: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('A valid ISO date is required', code);
  }
  return d;
}
