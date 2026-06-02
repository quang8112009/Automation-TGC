/**
 * Property-based test for the ai-reporting-and-ops-enhancements spec —
 * Report_State_Machine (Property 7).
 *
 * Kept in a SEPARATE file from `ai-reporting-and-ops.properties.test.ts` to avoid
 * a write collision while that file is authored in parallel. Each test is tagged
 * with its DESIGN-canonical property number/text and runs >= 100 generated cases.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  reportTransition,
  REPORT_TRANSITIONS,
} from '../src/reporting/reportStateMachine';
import type { ReportStatus } from '../src/reporting/reportStateMachine';

const ALL_STATUSES: ReportStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'ARCHIVED',
  'INSUFFICIENT_DATA',
];

// Independent oracle of the valid transition set (mirrors the design text).
const VALID = new Set<string>([
  'DRAFT->IN_REVIEW',
  'IN_REVIEW->APPROVED',
  'DRAFT->ARCHIVED',
  'IN_REVIEW->ARCHIVED',
]);

describe('ai-reporting-and-ops-enhancements properties (report state machine)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 7: Report_State_Machine chỉ chấp nhận bước hợp lệ
  // Với mọi cặp (current, target) trạng thái báo cáo, reportTransition trả
  // { ok: true, status: target } khi và chỉ khi cặp đó thuộc tập
  // {DRAFT→IN_REVIEW, IN_REVIEW→APPROVED, DRAFT→ARCHIVED, IN_REVIEW→ARCHIVED};
  // mọi cặp khác trả { ok: false, status: 409 }.
  // Validates: Requirements 3.2, 3.3
  it('Property 7: reportTransition accepts only the valid transition set; everything else -> 409', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (current, target) => {
          const result = reportTransition(current, target);
          const isValid = VALID.has(`${current}->${target}`);
          if (isValid) {
            expect(result).toEqual({ ok: true, status: target });
          } else {
            expect(result).toEqual({ ok: false, status: 409 });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: ai-reporting-and-ops-enhancements, Property 7: Report_State_Machine chỉ chấp nhận bước hợp lệ
  // Exhaustive cross-check that the exported REPORT_TRANSITIONS table is exactly the
  // valid set and that every accepted pair comes from that table (no extras, no gaps).
  // Validates: Requirements 3.2, 3.3
  it('Property 7 (table integrity): REPORT_TRANSITIONS is exactly the accepted set', () => {
    // Every declared transition is accepted and round-trips to its target.
    for (const [a, b] of REPORT_TRANSITIONS) {
      expect(reportTransition(a, b)).toEqual({ ok: true, status: b });
      expect(VALID.has(`${a}->${b}`)).toBe(true);
    }
    expect(REPORT_TRANSITIONS.length).toBe(VALID.size);

    // Exhaustive sweep over the full status x status domain.
    for (const current of ALL_STATUSES) {
      for (const target of ALL_STATUSES) {
        const result = reportTransition(current, target);
        if (VALID.has(`${current}->${target}`)) {
          expect(result).toEqual({ ok: true, status: target });
        } else {
          expect(result).toEqual({ ok: false, status: 409 });
        }
      }
    }
  });
});
