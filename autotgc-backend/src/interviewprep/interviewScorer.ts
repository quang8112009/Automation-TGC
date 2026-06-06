/**
 * Interview_Scorer — pure, framework-free rubric scoring for visa interview
 * practice answers (Requirements 11.2, 11.3, 11.5, 11.6).
 *
 * Mirrors the divide-by-zero discipline used elsewhere in the codebase
 * (`analytics/scoring.ts`, `recruitment/documents/completion.ts`): the score is
 * a weighted average of per-criterion scores that is ALWAYS in the closed
 * interval [0, 1] and never `NaN`/`Infinity`. Unlike `INSUFFICIENT_DATA`
 * label-returning metrics, this scorer performs a DUAL RETURN when the total
 * weight is 0: it surfaces `insufficientData = true` AND a finite default score
 * (`0.0`) at the same time, without performing any division (Req 11.5).
 *
 * The scorer defines its own interfaces and does not depend on
 * `interviewQuestionBank.ts` / `types.ts` (created in parallel under task 4.1),
 * keeping the pure scoring core independently property-testable.
 */

/**
 * A single rubric dimension contributing to an interview answer score.
 *
 * - `weight` may be `0`, and the sum of all weights may be `0` (Req 11.5).
 * - `score` is expected in the closed interval [0, 1]; values outside the range
 *   (or non-finite) are clamped defensively so the aggregate never escapes
 *   [0, 1] (Req 11.6).
 */
export interface AnswerCriterion {
  key: string;
  /** Non-negative rubric weight. May be 0; the total across criteria may be 0. */
  weight: number;
  /** Per-criterion score, expected in [0, 1] (clamped defensively). */
  score: number;
}

/**
 * Result of scoring an interview answer.
 *
 * - `score` is ALWAYS a finite value in [0, 1] (Req 11.2, 11.6).
 * - `insufficientData` is `true` exactly when the total rubric weight is 0, in
 *   which case `score` is still returned as a finite default (`0.0`) — the dual
 *   return required by Req 11.5.
 */
export interface InterviewScore {
  /** Aggregate answer score, always finite and in [0, 1]. */
  score: number;
  /** `true` when the total rubric weight is 0 (no division performed). */
  insufficientData: boolean;
}

/** Default score returned when the total rubric weight is 0 (Req 11.5). */
const DEFAULT_SCORE = 0.0;

/**
 * Clamp a number into the closed interval [lo, hi]; non-finite values (`NaN`,
 * `Infinity`, `-Infinity`) map to `lo`. Keeps the aggregate finite and bounded.
 */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Sanitize a rubric weight into a finite, non-negative value. Invalid weights
 * (`NaN`/`Infinity`/negative) are treated as `0` so they neither corrupt the
 * weighted sum nor make the denominator negative or non-finite.
 */
function sanitizeWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  return weight;
}

/**
 * Score a single interview answer as the weighted average of its rubric
 * criterion scores.
 *
 * - Pure + deterministic: identical input always yields identical output
 *   (Req 11.3).
 * - The result `score` is ALWAYS finite and in the closed interval [0, 1];
 *   per-criterion scores are clamped to [0, 1] and weights sanitized to finite
 *   non-negative values before aggregation, so the output is never `NaN` or
 *   `Infinity` (Req 11.2, 11.6).
 * - When the total (sanitized) weight is 0, NO division is performed; instead
 *   the scorer returns BOTH `insufficientData = true` AND a finite default
 *   `score` of `0.0` simultaneously (Req 11.5).
 *
 * @param criteria Rubric criteria for the answer (each with a weight and a
 *   per-criterion score). May be empty or carry only zero weights.
 * @returns An {@link InterviewScore} whose `score` is finite and in [0, 1].
 */
export function scoreAnswer(criteria: readonly AnswerCriterion[]): InterviewScore {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const criterion of criteria) {
    const weight = sanitizeWeight(criterion.weight);
    if (weight === 0) continue;
    totalWeight += weight;
    weightedSum += weight * clamp(criterion.score, 0, 1);
  }

  // Total weight 0 → dual return: insufficientData flag + finite default score,
  // without performing any division (Req 11.5).
  if (totalWeight === 0) {
    return { score: DEFAULT_SCORE, insufficientData: true };
  }

  // Denominator is finite and > 0, numerator is a sum of finite terms each in
  // [0, weight], so the quotient is finite and in [0, 1]; clamp defensively to
  // guarantee the bound under floating-point rounding (Req 11.2, 11.6).
  return { score: clamp(weightedSum / totalWeight, 0, 1), insufficientData: false };
}
