/**
 * GroundedAssistant — a reusable, AI-OPTIONAL "grounded assistant with tools"
 * use-case that composes the whole harness for ANY domain:
 *
 *   Context (grounding builder)  →  ChatCompleter (DeepSeek)  →  runAgentLoop
 *   (bounded + governed)         →  ToolRegistry (allow-list)  →  result,
 *   with a deterministic fallback whenever AI is unavailable.
 *
 * It is domain-agnostic by construction:
 *  - The caller supplies a `systemPrompt` (role/policy) and the grounded
 *    context for THIS request (knowledge, persona, profile — already assembled
 *    by the domain, e.g. via KnowledgeService). The assistant never invents
 *    grounding itself.
 *  - The caller supplies the `ToolRegistry` (which tools are allowed) — so the
 *    same engine powers recruitment Q&A, study-abroad advising, ops helpers,
 *    etc., just by registering different read-only tools.
 *  - A `fallback` function produces a deterministic grounded answer used when
 *    the AI is not configured or fails. The result ALWAYS carries
 *    `aiGenerated`, and the AI-OPTIONAL invariant is enforced via
 *    `enforceAiGeneratedFlag`: a fallback answer can never be flagged AI.
 *
 * The engine NEVER throws for AI reasons and NEVER lets a 502 reach the end
 * user — mirroring every existing AI consumer. It also returns the tool trail
 * and iteration count so callers/telemetry can inspect what happened.
 */
import { runAgentLoop } from './aiAgentLoop';
import type { ChatCompleter, ChatMessage } from './aiAgentLoop';
import type { ToolRegistry, ToolResult } from './aiToolCalls';
import { enforceAiGeneratedFlag } from './aiOptional';

/** A grounded request to the assistant. */
export interface AssistantRequest {
  /** Role/policy framing (e.g. "Bạn là chuyên viên tư vấn du học…"). */
  systemPrompt: string;
  /**
   * Pre-assembled grounding context for THIS request (knowledge entries,
   * persona, profile facts). The domain builds this deterministically; the
   * assistant passes it verbatim. Never contains secrets.
   */
  groundingContext: string;
  /** The user's question/instruction. */
  userMessage: string;
}

/** Result of an assistant run — always carries the AI-OPTIONAL flag. */
export interface AssistantResult {
  /** The answer text (AI-produced or deterministic fallback). */
  answer: string;
  /** True ONLY when the text came from the AI provider. */
  aiGenerated: boolean;
  /** Tool results produced during the loop (empty on the fallback path). */
  toolResults: ToolResult[];
  /** Completer round-trips performed (0 when AI was never invoked). */
  iterations: number;
  /**
   * Why the AI path did not produce text, when it didn't. `undefined` on the
   * AI-success path. One of the loop's failure reasons, surfaced for telemetry.
   */
  fallbackReason?: 'COMPLETER_ERROR' | 'MAX_ITERATIONS' | 'EMPTY_TOOL_TURN' | 'NO_COMPLETER';
}

/** Deterministic, grounded fallback answer builder (domain-supplied). */
export type FallbackBuilder = (request: AssistantRequest) => string;

export interface GroundedAssistantOptions {
  /** Hard cap on agent-loop iterations (clamped to [1,16] by the loop). */
  maxIterations?: number;
}

/**
 * The reusable engine. Inject a `ChatCompleter` (or `undefined` to force the
 * deterministic path), the allow-list `ToolRegistry`, and a `fallback` builder.
 */
export class GroundedAssistant {
  constructor(
    private readonly completer: ChatCompleter | undefined,
    private readonly registry: ToolRegistry,
    private readonly fallback: FallbackBuilder,
    private readonly options: GroundedAssistantOptions = {},
  ) {}

  /**
   * Answer a grounded request. Runs the bounded, governed agent loop when a
   * completer is configured; on ANY AI failure (not configured, provider error,
   * budget exhausted, empty turn) it returns the deterministic fallback with
   * `aiGenerated:false`. Never throws for AI reasons.
   */
  async run(request: AssistantRequest): Promise<AssistantResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: request.systemPrompt },
      { role: 'system', content: `[GroundedContext]\n${request.groundingContext}` },
      { role: 'user', content: request.userMessage },
    ];

    if (!this.completer) {
      return this.fallbackResult(request, 'NO_COMPLETER', [], 0);
    }

    const result = await runAgentLoop(this.completer, this.registry, messages, {
      maxIterations: this.options.maxIterations,
    });

    if (result.ok && result.text.trim().length > 0) {
      return enforceAiGeneratedFlag(
        {
          answer: result.text.trim(),
          aiGenerated: true,
          toolResults: result.toolResults,
          iterations: result.iterations,
        },
        'AI',
      );
    }

    // Any non-text outcome (or empty text) → deterministic fallback, carrying
    // the loop's failure reason + tool trail for observability.
    const reason = result.ok ? 'EMPTY_TOOL_TURN' : result.reason;
    return this.fallbackResult(request, reason, result.toolResults, result.iterations);
  }

  /** Build a deterministic fallback result with the AI flag forced false. */
  private fallbackResult(
    request: AssistantRequest,
    reason: AssistantResult['fallbackReason'],
    toolResults: ToolResult[],
    iterations: number,
  ): AssistantResult {
    const answer = this.fallback(request);
    return enforceAiGeneratedFlag(
      { answer, aiGenerated: false, toolResults, iterations, fallbackReason: reason },
      'FALLBACK',
    );
  }
}
