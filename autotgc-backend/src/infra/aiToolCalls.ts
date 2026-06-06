/**
 * Tool-call layer for AI text generation (harness layer: Tool).
 *
 * DeepSeek V4 (OpenAI-compatible) can return `tool_calls` on the assistant
 * message when tools are offered. This module provides PURE, governed handling
 * of that shape so the model can request a tool WITHOUT the system ever
 * executing something it did not explicitly allow:
 *
 *  - `parseToolCalls` extracts and validates tool calls from a raw response
 *    body, tolerating malformed входные (returns [] rather than throwing).
 *  - `ToolRegistry` is an explicit ALLOW-LIST of named tools. A call to an
 *    unregistered tool is rejected (governance: no arbitrary tool execution),
 *    and arguments are validated by the tool before its handler runs.
 *  - `dispatchToolCall` routes a parsed call to its registered handler and
 *    always returns a structured `ToolResult` (never throws), so the
 *    orchestration loop stays robust.
 *
 * This is the seam a future agentic loop would use; it is intentionally
 * decoupled from `AiTextClient` so the existing single-shot `generateContent`
 * path and the AI-OPTIONAL discipline are untouched.
 */
import { isRecord, asString } from '../platforms/narrow';

/** A tool call requested by the model (OpenAI/DeepSeek `tool_calls` entry). */
export interface ToolCall {
  /** Provider-assigned id of the call (echoed back with the result). */
  id: string;
  /** Name of the tool the model wants to invoke. */
  name: string;
  /** Parsed JSON arguments object (never a raw string). */
  arguments: Record<string, unknown>;
}

/** Outcome of dispatching a tool call. Discriminated, never thrown. */
export type ToolResult =
  | { ok: true; toolCallId: string; name: string; output: unknown }
  | { ok: false; toolCallId: string; name: string; error: string; code: ToolErrorCode };

export type ToolErrorCode =
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_BAD_ARGUMENTS'
  | 'TOOL_EXECUTION_FAILED';

/** A registered, allow-listed tool. */
export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  /**
   * Validate/narrow the raw arguments object. Return the typed args on success,
   * or `undefined` to reject as TOOL_BAD_ARGUMENTS. Must be pure/total.
   */
  validate(args: Record<string, unknown>): A | undefined;
  /** Execute the tool with validated args. May be async. */
  handler(args: A): Promise<unknown> | unknown;
}

/**
 * Parse `tool_calls` from a raw OpenAI/DeepSeek chat-completions response body.
 * Tolerant by design: any malformed entry is skipped, and a body with no tool
 * calls yields `[]`. Arguments arriving as a JSON string are parsed; if they do
 * not parse to an object the call is skipped (it cannot be safely dispatched).
 */
export function parseToolCalls(body: unknown): ToolCall[] {
  const message = readMessage(body);
  if (!message) return [];
  const rawCalls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(rawCalls)) return [];

  const calls: ToolCall[] = [];
  for (const entry of rawCalls) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id) ?? '';
    const fn = entry.function;
    if (!isRecord(fn)) continue;
    const name = asString(fn.name);
    if (!name) continue;

    const args = coerceArguments(fn.arguments);
    if (args === undefined) continue; // unparseable args → skip (cannot dispatch safely)

    calls.push({ id, name, arguments: args });
  }
  return calls;
}

/** Pull `choices[0].message` out of a response body, if present. */
function readMessage(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  return isRecord(first.message) ? first.message : undefined;
}

/**
 * Coerce a tool-call `arguments` field into an object. Accepts an object as-is,
 * or a JSON string that parses to an object. Anything else → `undefined`.
 */
function coerceArguments(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  // Absent arguments are treated as an empty object (a no-arg tool call).
  if (raw === undefined || raw === null) return {};
  return undefined;
}

/**
 * An explicit allow-list of tools. Only registered tools can be dispatched —
 * the governance guarantee that the model cannot trigger arbitrary execution.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<Record<string, unknown>>>();

  /** Register a tool. Re-registering the same name overwrites (last wins). */
  register<A = Record<string, unknown>>(def: ToolDefinition<A>): this {
    // Store with a widened signature; validate() narrows at dispatch time.
    this.tools.set(def.name, def as unknown as ToolDefinition<Record<string, unknown>>);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Names of all allow-listed tools (sorted for deterministic listing). */
  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  get(name: string): ToolDefinition<Record<string, unknown>> | undefined {
    return this.tools.get(name);
  }
}

/**
 * Dispatch a single parsed tool call against the registry. NEVER throws:
 *  - unknown tool        → TOOL_NOT_ALLOWED
 *  - args fail validate  → TOOL_BAD_ARGUMENTS
 *  - handler throws      → TOOL_EXECUTION_FAILED
 * On success returns the handler output wrapped in a `ToolResult`.
 */
export async function dispatchToolCall(registry: ToolRegistry, call: ToolCall): Promise<ToolResult> {
  const def = registry.get(call.name);
  if (!def) {
    return { ok: false, toolCallId: call.id, name: call.name, error: `Tool not allowed: ${call.name}`, code: 'TOOL_NOT_ALLOWED' };
  }

  const validated = def.validate(call.arguments);
  if (validated === undefined) {
    return { ok: false, toolCallId: call.id, name: call.name, error: 'Invalid tool arguments', code: 'TOOL_BAD_ARGUMENTS' };
  }

  try {
    const output = await def.handler(validated);
    return { ok: true, toolCallId: call.id, name: call.name, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'tool execution failed';
    return { ok: false, toolCallId: call.id, name: call.name, error: message, code: 'TOOL_EXECUTION_FAILED' };
  }
}

/** Dispatch many tool calls in order, collecting a result per call. */
export async function dispatchToolCalls(registry: ToolRegistry, calls: readonly ToolCall[]): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    results.push(await dispatchToolCall(registry, call));
  }
  return results;
}
