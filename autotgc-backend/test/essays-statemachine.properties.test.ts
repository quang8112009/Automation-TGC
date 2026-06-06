/**
 * Property-based test for the study-abroad-ai-advisor-suite spec —
 * Essay_State_Machine (Property 10).
 *
 * Kept in a SEPARATE file from the other essays property tests
 * (`essays.properties.test.ts`) to avoid a write collision while those are
 * authored in parallel. The test is tagged with its DESIGN-canonical property
 * number/text and runs >= 100 generated cases on fast-check.
 *
 * Mirrors the style of `analytics-feedback.properties.test.ts`
 * (insightTransition / INSIGHT_TRANSITIONS) and
 * `ai-reporting-statemachine.properties.test.ts` (reportTransition).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  essayTransition,
  ESSAY_TRANSITIONS,
} from '../src/essays/essayStateMachine';
import type { EssayStatus } from '../src/essays/essayStateMachine';

// The four EssayStatus values the lifecycle is drawn from.
const ALL_STATUSES: EssayStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ARCHIVED'];

// Independent oracle of the valid transition set (mirrors the design text):
// DRAFT→IN_REVIEW, IN_REVIEW→APPROVED, DRAFT→ARCHIVED, IN_REVIEW→ARCHIVED.
const VALID = new Set<string>([
  'DRAFT->IN_REVIEW',
  'IN_REVIEW->APPROVED',
  'DRAFT->ARCHIVED',
  'IN_REVIEW->ARCHIVED',
]);

describe('study-abroad-ai-advisor-suite properties (essay state machine)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 10: Essay_State_Machine chỉ chấp nhận bước hợp lệ
  // Với mọi cặp (current, target) lấy từ 4 giá trị EssayStatus, essayTransition trả
  // { ok: true, status: target } khi và chỉ khi cặp đó thuộc ESSAY_TRANSITIONS
  // {DRAFT→IN_REVIEW, IN_REVIEW→APPROVED, DRAFT→ARCHIVED, IN_REVIEW→ARCHIVED};
  // mọi cặp khác trả { ok: false, status: 409 }; và hàm là thuần + xác định
  // (cùng input → cùng kết quả qua hai lần gọi).
  // Validates: Requirements 8.1, 8.2, 8.5, 17.3, 19.9
  it('Property 10: essayTransition accepts only the valid transition set (iff); everything else -> 409; deterministic', () => {
    // Cross-check the exported table itself matches the oracle exactly (no extras/gaps).
    expect(ESSAY_TRANSITIONS.length).toBe(VALID.size);
    for (const [a, b] of ESSAY_TRANSITIONS) {
      expect(VALID.has(`${a}->${b}`)).toBe(true);
    }

    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (current, target) => {
          const result = essayTransition(current, target);
          const isValid = VALID.has(`${current}->${target}`);

          // ok:true with status:target IFF the pair is a declared transition; else 409.
          if (isValid) {
            expect(result).toEqual({ ok: true, status: target });
          } else {
            expect(result).toEqual({ ok: false, status: 409 });
          }

          // Pure + deterministic: a second call on the same input yields the same result.
          expect(essayTransition(current, target)).toEqual(result);
        },
      ),
      { numRuns: 100 },
    );
  });
});
