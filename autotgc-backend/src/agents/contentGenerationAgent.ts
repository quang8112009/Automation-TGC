/**
 * ContentGenerationAgent (AI Execution Layer).
 *
 * Wraps the Content Pipeline `GenerationService` as a reusable Agent so an
 * orchestrated workflow can produce an AI content draft as one step. It reads
 * `domainName` / `personaIds` / `objective` from the workflow variables, calls
 * `generate()`, and returns the new draft id in `output`. Validation / domain
 * errors are surfaced as `{ ok: false, error }` so the orchestrator records a
 * deterministic step failure rather than crashing the run.
 */
import type { Agent, AgentContext, AgentResult } from './agent';
import { readString, readStringArray } from './agent';
import { AppError } from '../infra/errors';
import type { GenerationService } from '../content/generationService';

/** The variable keys this agent consumes from the workflow context. */
export const CONTENT_GENERATION_INPUT_KEYS = ['domainName', 'personaIds', 'objective'] as const;

export class ContentGenerationAgent implements Agent {
  public readonly name = 'generate_content';

  constructor(private readonly generationService: GenerationService) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    const domainName = readString(ctx.variables, 'domainName');
    const personaIds = readStringArray(ctx.variables, 'personaIds');
    const objective = readString(ctx.variables, 'objective');

    try {
      const result = await this.generationService.generate({
        domainName,
        personaIds,
        objective,
      });
      return {
        ok: true,
        output: {
          draftId: result.draft.id,
          generatedWithoutFeedback: result.generatedWithoutFeedback,
        },
      };
    } catch (err) {
      // Deterministic domain/validation errors -> structured failure.
      if (err instanceof AppError) {
        return { ok: false, error: `${err.code}: ${err.message}` };
      }
      // Re-throw unknown/transient errors so withRetry can retry them.
      throw err;
    }
  }
}
