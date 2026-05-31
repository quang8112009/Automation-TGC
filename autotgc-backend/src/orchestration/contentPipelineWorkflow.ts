/**
 * Content pipeline workflow definition (Agentic Orchestration Layer).
 *
 * Assembles the canonical agentic content pipeline:
 *   1. generate_content  -> ContentGenerationAgent (AI draft creation)
 *   2. await_review      -> human approval gate (requiresApproval; no-op run)
 *   3. schedule          -> SchedulingService.schedule when inputs are present
 *
 * The workflow is resilient: any step whose backing dependency is not supplied
 * degrades to a no-op that returns `{ ok: true }`, so partial wiring never
 * crashes a run.
 */
import type { AgentContext, AgentResult } from '../agents/agent';
import { readString, readStringArray, readStringRecord } from '../agents/agent';
import { ContentGenerationAgent } from '../agents/contentGenerationAgent';
import type { GenerationService } from '../content/generationService';
import type { SchedulingService } from '../content/schedulingService';
import { AppError } from '../infra/errors';
import type { StepDefinition, WorkflowDefinition } from './types';

export const CONTENT_PIPELINE_TYPE = 'content_pipeline';

export interface ContentPipelineDeps {
  /** When provided, step 1 generates a real draft; otherwise it's a no-op. */
  generationService?: GenerationService;
  /** When provided, step 3 can schedule the approved draft; otherwise no-op. */
  schedulingService?: SchedulingService;
}

/** Build the content pipeline workflow definition from the available deps. */
export function buildContentPipelineWorkflow(deps: ContentPipelineDeps = {}): WorkflowDefinition {
  const steps: StepDefinition[] = [
    buildGenerateStep(deps.generationService),
    buildReviewStep(),
    buildScheduleStep(deps.schedulingService),
  ];
  return { type: CONTENT_PIPELINE_TYPE, steps };
}

/** Step 1: generate content via the agent, or no-op when generation isn't wired. */
function buildGenerateStep(generationService?: GenerationService): StepDefinition {
  if (!generationService) {
    return { name: 'generate_content', run: passthrough };
  }
  const agent = new ContentGenerationAgent(generationService);
  return { name: 'generate_content', run: (ctx) => agent.run(ctx) };
}

/** Step 2: human review gate. The run pauses here; resume re-runs this as a no-op pass. */
function buildReviewStep(): StepDefinition {
  return {
    name: 'await_review',
    requiresApproval: true,
    run: passthrough,
  };
}

/** Step 3: schedule the approved draft when schedule inputs are present, else no-op. */
function buildScheduleStep(schedulingService?: SchedulingService): StepDefinition {
  return {
    name: 'schedule',
    run: async (ctx: AgentContext): Promise<AgentResult> => {
      if (!schedulingService) return { ok: true };

      const draftId = readString(ctx.variables, 'draftId');
      const platforms = readStringArray(ctx.variables, 'platforms');
      const scheduledAt = readStringRecord(ctx.variables, 'scheduledAt');

      // Resilient: nothing to schedule -> pass without side effects.
      if (!draftId || platforms.length === 0 || !scheduledAt) {
        return { ok: true, output: { scheduled: false } };
      }

      try {
        const result = await schedulingService.schedule({ draftId, platforms, scheduledAt });
        return {
          ok: true,
          output: {
            scheduled: true,
            scheduledPostIds: result.created.map((p) => p.id),
            rejectedPlatforms: result.rejected.map((r) => r.platform),
          },
        };
      } catch (err) {
        if (err instanceof AppError) {
          return { ok: false, error: `${err.code}: ${err.message}` };
        }
        throw err;
      }
    },
  };
}

/** A step that simply succeeds, carrying no output. */
async function passthrough(_ctx: AgentContext): Promise<AgentResult> {
  return { ok: true };
}
