/**
 * Property-based test for the document-checklist completion metric
 * (ai-reporting-and-ops-enhancements, Property 16).
 *
 * Lives in its own file to avoid collisions with the shared
 * `ai-reporting-and-ops.properties.test.ts` suite that other tasks populate.
 * Runs >= 100 generated cases via fast-check.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { completionMetric } from '../src/recruitment/documents/completion';
import type { ChecklistItemLike, DocSubmissionStatus } from '../src/recruitment/documents/completion';

const STATUSES: DocSubmissionStatus[] = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'];

const checklistItemArb: fc.Arbitrary<ChecklistItemLike> = fc.record({
  required: fc.boolean(),
  status: fc.constantFrom(...STATUSES),
});

describe('ai-reporting-and-ops-enhancements properties (document checklist completion)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 16: Chỉ số hoàn thành đúng công thức, an toàn chia 0, và trong [0, 1]
  // Với mọi tập Document_Checklist_Item, completionMetric bằng (số mục required ở trạng thái VERIFIED) /
  // (tổng số mục required) và luôn nằm trong đoạn [0, 1]; nếu tổng số mục required bằng 0 thì trả về
  // 'INSUFFICIENT_DATA' thay vì thực hiện phép chia (không bao giờ NaN/Infinity).
  // Validates: Requirements 13.4, 13.5
  it('Property 16: completion metric follows the formula, is divide-by-zero safe, and stays in [0, 1]', () => {
    fc.assert(
      fc.property(fc.array(checklistItemArb, { maxLength: 50 }), (items) => {
        const result = completionMetric(items);

        // Oracle: independently recompute the required-VERIFIED / total-required ratio.
        const requiredItems = items.filter((i) => i.required);
        const totalRequired = requiredItems.length;
        const verifiedRequired = requiredItems.filter((i) => i.status === 'VERIFIED').length;

        if (totalRequired === 0) {
          // No required items → INSUFFICIENT_DATA, no division performed.
          expect(result).toBe('INSUFFICIENT_DATA');
          return;
        }

        // Otherwise numeric and matches the exact formula.
        expect(typeof result).toBe('number');
        const value = result as number;
        expect(value).toBeCloseTo(verifiedRequired / totalRequired, 12);

        // Never NaN / Infinity, always within the closed interval [0, 1].
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});
