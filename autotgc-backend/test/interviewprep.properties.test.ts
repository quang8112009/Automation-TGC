/**
 * Property-based tests for the study-abroad-ai-advisor-suite spec —
 * Interview prep (`src/interviewprep/interviewScorer.ts`).
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: study-abroad-ai-advisor-suite, Property {n}: {design text}`) and
 * runs >= 100 generated cases on fast-check. The scorer is a pure,
 * framework-free module, so no fakes/clock injection are required — runs are
 * deterministic by construction.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { scoreAnswer } from '../src/interviewprep/interviewScorer';
import type { AnswerCriterion } from '../src/interviewprep/interviewScorer';

// Default score the scorer returns when the total (sanitized) weight is 0.
const DEFAULT_SCORE = 0.0;

// Numbers that exercise the scorer's defensive sanitization/clamping: ordinary
// doubles PLUS the awkward values (0, negatives, out-of-range, non-finite) that
// must never leak NaN/Infinity into the aggregate.
const messyNumber: fc.Arbitrary<number> = fc.oneof(
  fc.double({ noNaN: false, noDefaultInfinity: false }),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -0,
    -1,
    -100,
    0.25,
    0.5,
    1,
    1.5,
    2,
    1000,
  ),
);

const criterionArb: fc.Arbitrary<AnswerCriterion> = fc.record({
  key: fc.string({ maxLength: 8 }),
  weight: messyNumber,
  score: messyNumber,
});

// Mirror the scorer's weight sanitization: invalid/non-positive weights -> 0.
function sanitizeWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  return weight;
}

describe('study-abroad-ai-advisor-suite properties (interview scorer)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 5: Điểm chấm phỏng vấn trong [0,1] và dual-return khi tổng trọng số bằng 0
  // For any array of rubric criteria (weights/scores including 0, negatives,
  // out-of-range, and non-finite values, plus empty arrays): scoreAnswer returns
  // a score in the closed interval [0, 1] and never NaN/Infinity; when the sum of
  // sanitized weights is 0, the result carries insufficientData === true AND a
  // finite default score (0.0) simultaneously; and the function is deterministic.
  // Validates: Requirements 11.2, 11.3, 11.5, 11.6, 19.4
  it('Property 5: interview score stays in [0,1] with a dual return when total weight is 0', () => {
    fc.assert(
      fc.property(fc.array(criterionArb, { maxLength: 12 }), (criteria) => {
        const result = scoreAnswer(criteria);

        // Always a finite score in the closed interval [0, 1] (Req 11.2, 11.6).
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);

        // Dual return when the total sanitized weight is 0 (Req 11.5): both the
        // insufficientData flag AND a finite default score of 0.0, with no
        // division performed.
        const totalWeight = criteria.reduce((sum, c) => sum + sanitizeWeight(c.weight), 0);
        if (totalWeight === 0) {
          expect(result.insufficientData).toBe(true);
          expect(result.score).toBe(DEFAULT_SCORE);
          expect(Number.isFinite(result.score)).toBe(true);
        } else {
          expect(result.insufficientData).toBe(false);
        }

        // Pure + deterministic: identical input yields identical output (Req 11.3).
        const again = scoreAnswer(criteria);
        expect(again).toEqual(result);
      }),
      { numRuns: 100 },
    );
  });
});
