/**
 * Property-based tests for the study-abroad-ai-advisor-suite Essay_Reviewer.
 *
 * The test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: study-abroad-ai-advisor-suite, Property {n}: {exact design text}`)
 * and runs >= 100 generated cases on fast-check. The Essay_Reviewer is pure and
 * framework-free, so it is exercised directly with no fakes or injected clock.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { reviewEssay } from '../src/essays/essayReviewer';
import type { RubricCriterion, EssayDocType } from '../src/essays/types';

// --- shared constants & generators ------------------------------------------

const DOC_TYPES: EssayDocType[] = ['SOP', 'MOTIVATION', 'CV'];
const RUBRIC_KEYS: RubricCriterion['key'][] = [
  'structure',
  'relevance',
  'lengthCompliance',
  'requiredSections',
];

// Weights that intentionally include 0, positive, negative and non-finite values
// so the divide-by-zero (total weight 0) path is exercised (Req 7.4).
const weightArb = fc.oneof(
  fc.constant(0),
  fc.double({ min: -5, max: 5, noNaN: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

// Scores that can be out of [0,1] and non-finite so the defensive clamp is
// exercised (Req 7.6).
const scoreArb = fc.oneof(
  fc.double({ min: -2, max: 3, noNaN: true }),
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

const criterionArb: fc.Arbitrary<RubricCriterion> = fc.record({
  key: fc.constantFrom(...RUBRIC_KEYS),
  weight: weightArb,
  score: scoreArb,
});

// Rubric generator covers: empty rubric, arbitrary rubric, and explicit
// all-zero-weight (non-empty) rubric so the total-weight-0 case is well covered.
const zeroWeightRubricArb: fc.Arbitrary<RubricCriterion[]> = fc.array(
  fc.record({
    key: fc.constantFrom(...RUBRIC_KEYS),
    weight: fc.constant(0),
    score: scoreArb,
  }),
  { minLength: 1, maxLength: 6 },
);

const rubricArb: fc.Arbitrary<RubricCriterion[]> = fc.oneof(
  fc.array(criterionArb, { maxLength: 8 }), // includes the empty rubric
  zeroWeightRubricArb,
);

// Oracle mirroring the reviewer's weight sanitization: a weight contributes only
// when finite and positive, otherwise it is treated as 0.
function effectiveWeightSum(rubric: readonly RubricCriterion[]): number {
  return rubric.reduce(
    (sum, c) => sum + (Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0),
    0,
  );
}

// =============================================================================
// Essay_Reviewer property
// =============================================================================

describe('study-abroad-ai-advisor-suite properties (essays)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 4: Điểm chấm essay trong [0,1], xác định, và an toàn khi tổng trọng số bằng 0
  // Validates: Requirements 7.1, 7.2, 7.4, 7.6, 19.3
  // For any essay content and any rubric (weights possibly 0, scores possibly
  // out of range/non-finite), reviewEssay returns a score in the closed interval
  // [0,1], never NaN/Infinity; when the total weight is 0 the score is exactly
  // 0.0; and calling twice with identical inputs yields identical score and
  // identical feedback (determinism).
  it('Property 4: score in [0,1], deterministic, and safe when total weight is 0', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.constantFrom(...DOC_TYPES),
        rubricArb,
        (content, docType, rubric) => {
          const review = reviewEssay(content, docType, rubric);

          // Score is always within the closed interval [0,1] and finite (Req 7.1, 7.6).
          expect(Number.isFinite(review.score)).toBe(true);
          expect(review.score).toBeGreaterThanOrEqual(0);
          expect(review.score).toBeLessThanOrEqual(1);

          // Total weight 0 -> score is exactly 0.0, no division, no hard-fail (Req 7.4).
          if (effectiveWeightSum(rubric) === 0) {
            expect(review.score).toBe(0);
          }

          // Determinism: identical inputs -> identical score and feedback (Req 7.2).
          const again = reviewEssay(content, docType, rubric);
          expect(again.score).toBe(review.score);
          expect(again.feedback).toEqual(review.feedback);
        },
      ),
      { numRuns: 100 },
    );
  });
});
