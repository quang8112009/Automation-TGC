/**
 * Agent abstraction (AI Execution Layer).
 *
 * An Agent is a single, named unit of AI/automation work that an orchestrated
 * workflow step can invoke. Agents are framework-free and side-effect-light:
 * they receive the accumulated workflow context (`variables`) and return a
 * structured result. Failures are returned as `{ ok: false, error }` rather than
 * thrown, so the orchestrator can persist the failure deterministically; agents
 * MAY still throw for transient/infrastructure errors that the orchestrator's
 * retry helper should retry.
 */

/** Execution context handed to an agent by the orchestrator. */
export interface AgentContext {
  /** The WorkflowRun id this invocation belongs to. */
  runId: string;
  /** Accumulated workflow variables (initial inputs merged with prior outputs). */
  variables: Record<string, unknown>;
}

/** Structured outcome of an agent invocation. */
export interface AgentResult {
  ok: boolean;
  /** Outputs merged into the workflow context on success. */
  output?: Record<string, unknown>;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

/** A named, runnable agent. */
export interface Agent {
  readonly name: string;
  run(ctx: AgentContext): Promise<AgentResult>;
}

/** True when `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce an unknown value into a plain record (empty when not an object). */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Read a non-empty string variable, or undefined. */
export function readString(variables: Record<string, unknown>, key: string): string | undefined {
  const v = variables[key];
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** Read an array-of-strings variable (filters out non-strings); [] when absent. */
export function readStringArray(variables: Record<string, unknown>, key: string): string[] {
  const v = variables[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/** Read a record-of-strings variable, or undefined when absent/ill-typed. */
export function readStringRecord(
  variables: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const v = variables[key];
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value === 'string') out[k] = value;
  }
  return out;
}
