/**
 * Exponential-backoff retry helper (AI Execution Layer).
 *
 * Used by agents and the orchestrator to make transient AI / network failures
 * recoverable. The delay grows exponentially (base * 2^attemptIndex). The sleep
 * function is injected so tests can run deterministically without real timers;
 * it defaults to a real `setTimeout`-based sleep.
 */

/** Pluggable async sleep, in milliseconds. */
export type SleepFn = (ms: number) => Promise<void>;

/** Default sleep backed by `setTimeout`. */
export const realSleep: SleepFn = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RetryOptions {
  /** Total attempts (including the first). Defaults to 3. Clamped to >= 1. */
  attempts?: number;
  /** Base delay in ms used for exponential backoff. Defaults to 500. Clamped to >= 0. */
  baseDelayMs?: number;
}

/**
 * Run `fn`, retrying on rejection with exponential backoff.
 *
 * - Resolves with the first successful result.
 * - After exhausting all attempts, rejects with the last error.
 * - Delays are base * 2^(attemptIndex) and only applied between attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
  sleep: SleepFn = realSleep,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 500);

  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attemptIndex === attempts - 1;
      if (isLast) break;
      const delay = baseDelayMs * 2 ** attemptIndex;
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
