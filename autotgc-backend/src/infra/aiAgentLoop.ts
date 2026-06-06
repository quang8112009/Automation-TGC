/**
 * Bounded, governed agentic loop (harness layers: Tool + Orchestration).
 *
 * Lets an OpenAI/DeepSeek-compatible model drive a multi-step tool-use
 * conversation SAFELY, while keeping the existing single-shot
 * `AiTextClient.generateContent` path (and the AI-OPTIONAL discipline) entirely
 * untouched. Design choices that keep it from breaking the system:
 *
 *  - Depends on an injected `ChatCompleter` seam (NOT the HTTP client directly),
 *    so the loop is pure orchestration that is fully unit/property-testable with
 *    a fake completer. A real adapter wrapping the gateway can be added later
 *    without changing this logic.
 *  - BOUNDED: a hard `maxIterations` cap means the loop can never run forever or
 *    burn unbounded quota, even if the model keeps requesting tools.
 *  - GOVERNED: every requested tool is dispatched through the allow-list
 *    `ToolRegistry` (`dispatchToolCalls`), so the model can never trigger
 *    arbitrary execution.
 *  - NEVER THROWS: a completer error, an exhausted budget, or a bad turn all
 *    resolve to a structured failure result — callers decide how to fall back,
 *    exactly like the AI-OPTIONAL consumers do today.
 */
import type { ToolCall, ToolResult } from './aiToolCalls';
import { dispatchToolCalls, type ToolRegistry } from './aiToolCalls';

/** OpenAI/DeepSeek-style chat message used by the loop. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For role:'tool' — the id of the tool_call this message answers. */
  toolCallId?: string;
  /** For role:'tool' — the tool name (echoed for clarity). */
  name?: string;
}

/** One turn returned by the completer: either final text or tool requests. */
export type ChatTurn =
  | { kind: 'text'; content: string }
  | { kind: 'tool_calls'; toolCalls: ToolCall[] };

/**
 * The model seam the loop drives. An implementation issues one chat completion
 * over the given messages (optionally offering tool names) and reports whether
 * the model produced final text or requested tools.
 */
export interface ChatCompleter {
  complete(messages: readonly ChatMessage[], toolNames: readonly string[]): Promise<ChatTurn>;
}

export interface AgentLoopOptions {
  /** Hard cap on completer round-trips. Clamped to [1, 16]. Default 4. */
  maxIterations?: number;
}

/** Why the loop stopped without producing final text. */
export type AgentLoopFailureReason =
  | 'MAX_ITERATIONS' // budget exhausted while the model kept requesting tools
  | 'COMPLETER_ERROR' // the completer threw (network/provider error)
  | 'EMPTY_TOOL_TURN'; // model requested tools but the list was empty (no progress)

export type AgentLoopResult =
  | {
      ok: true;
      /** Final assistant text. */
      text: string;
      /** Number of completer round-trips performed (>= 1). */
      iterations: number;
      /** Every tool result produced across the loop, in order. */
      toolResults: ToolResult[];
      /** Full transcript including appended tool messages. */
      messages: ChatMessage[];
    }
  | {
      ok: false;
      reason: AgentLoopFailureReason;
      iterations: number;
      toolResults: ToolResult[];
      messages: ChatMessage[];
    };

const DEFAULT_MAX_ITERATIONS = 4;
const MAX_ITERATIONS_CEILING = 16;

/** Clamp the iteration budget into a sane bounded range. */
function resolveBudget(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_MAX_ITERATIONS;
  const floored = Math.floor(raw);
  if (floored < 1) return 1;
  if (floored > MAX_ITERATIONS_CEILING) return MAX_ITERATIONS_CEILING;
  return floored;
}

/** Render a tool result as a compact, deterministic `tool` message content. */
function toolResultContent(result: ToolResult): string {
  if (result.ok) {
    let serialized: string;
    try {
      serialized = JSON.stringify(result.output);
    } catch {
      serialized = String(result.output);
    }
    return `OK ${serialized}`;
  }
  return `ERROR ${result.code}: ${result.error}`;
}

/**
 * Run the bounded, governed agentic loop. Pure orchestration over the injected
 * `completer` and the allow-list `registry`. Never throws.
 *
 * Termination is guaranteed: each iteration either returns final text or
 * consumes one unit of the (finite) budget; once the budget is exhausted the
 * loop returns a `MAX_ITERATIONS` failure.
 */
export async function runAgentLoop(
  completer: ChatCompleter,
  registry: ToolRegistry,
  initialMessages: readonly ChatMessage[],
  options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  const budget = resolveBudget(options.maxIterations);
  const toolNames = registry.names();
  const messages: ChatMessage[] = [...initialMessages];
  const toolResults: ToolResult[] = [];

  for (let iteration = 1; iteration <= budget; iteration += 1) {
    let turn: ChatTurn;
    try {
      turn = await completer.complete(messages, toolNames);
    } catch {
      // Provider/network failure — surface a structured failure (no throw) so
      // the caller can fall back deterministically (AI-OPTIONAL spirit).
      return { ok: false, reason: 'COMPLETER_ERROR', iterations: iteration, toolResults, messages };
    }

    if (turn.kind === 'text') {
      messages.push({ role: 'assistant', content: turn.content });
      return { ok: true, text: turn.content, iterations: iteration, toolResults, messages };
    }

    // turn.kind === 'tool_calls'
    if (turn.toolCalls.length === 0) {
      // The model asked for tools but named none — no way to make progress.
      return { ok: false, reason: 'EMPTY_TOOL_TURN', iterations: iteration, toolResults, messages };
    }

    // Record the assistant's tool request, then dispatch through the allow-list.
    messages.push({
      role: 'assistant',
      content: `[tool_calls] ${turn.toolCalls.map((c) => c.name).join(', ')}`,
    });
    const results = await dispatchToolCalls(registry, turn.toolCalls);
    for (const result of results) {
      toolResults.push(result);
      messages.push({
        role: 'tool',
        toolCallId: result.toolCallId,
        name: result.name,
        content: toolResultContent(result),
      });
    }
    // Loop continues: the next completion sees the tool outputs.
  }

  // Budget exhausted while still requesting tools.
  return { ok: false, reason: 'MAX_ITERATIONS', iterations: budget, toolResults, messages };
}
