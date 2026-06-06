/**
 * AI-OPTIONAL invariant helpers (pure, side-effect free).
 *
 * Invariant: an output may only claim `aiGenerated = true` when its text was
 * produced by the AI_Text_Provider. Whenever a result originates from the
 * Deterministic_Fallback branch (`source === 'FALLBACK'`), the `aiGenerated`
 * flag MUST be `false`. This guard enforces that invariant at runtime so a
 * fallback output can never mislabel itself as AI-generated. (R3.3, R3.4)
 */

/**
 * Enforce the AI-OPTIONAL flag invariant.
 *
 * When the result comes from the deterministic fallback branch
 * (`source === 'FALLBACK'`) and its `aiGenerated` flag is `true`, returns a
 * shallow copy with `aiGenerated` reset to `false`. In every other case the
 * original `result` is returned unchanged (no copy, no mutation).
 *
 * @param result - The AI-optional result carrying an `aiGenerated` flag.
 * @param source - Where the result was produced: `'AI'` or `'FALLBACK'`.
 * @returns The original result, or a corrected shallow copy when the invariant
 *          would otherwise be violated.
 */
export function enforceAiGeneratedFlag<T extends { aiGenerated: boolean }>(
  result: T,
  source: 'AI' | 'FALLBACK',
): T {
  if (source === 'FALLBACK' && result.aiGenerated) {
    return { ...result, aiGenerated: false };
  }
  return result;
}
