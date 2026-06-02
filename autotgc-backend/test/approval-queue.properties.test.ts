/**
 * Property-based test for Approval_Queue manual-priority ordering
 * (ai-reporting-and-ops-enhancements spec — task 6.6, design Property 14).
 *
 * The test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: ai-reporting-and-ops-enhancements, Property 14: ...`) and runs
 * >= 100 generated cases on fast-check.
 *
 * `dashboard/assembler.buildApprovalQueue` is already a pure, DB-free function
 * (it takes the already-read DRAFT drafts ∪ PENDING_REVIEW insights and returns
 * the composed, ordered queue), so the ordering can be exercised deterministically
 * here without any Prisma/DB involvement.
 *
 * This file is intentionally separate from the shared
 * `ai-reporting-and-ops.properties.test.ts` to avoid collisions while that suite
 * is built out.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  buildApprovalQueue,
  compareApprovalItems,
} from '../src/dashboard/assembler';
import type { DraftLike, InsightLike } from '../src/dashboard/assembler';

/** A pool of ISO timestamps (and `null`) used for createdAt/deadlineAt. */
const isoOrNullArb = (): fc.Arbitrary<string | null> =>
  fc.option(
    fc
      .date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z') })
      .map((d) => d.toISOString()),
    { nil: null },
  );

const isoArb = (): fc.Arbitrary<string> =>
  fc
    .date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z') })
    .map((d) => d.toISOString());

const draftStatusArb = (): fc.Arbitrary<DraftLike['status']> =>
  fc.constantFrom('DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'FAILED');

const insightStatusArb = (): fc.Arbitrary<InsightLike['insightStatus']> =>
  fc.constantFrom('NEW', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

/**
 * Generate a set of drafts and insights with globally-unique ids (so a draft and
 * an insight never collide on id), arbitrary statuses (only DRAFT / PENDING_REVIEW
 * rows reach the queue), and a small priorityIndex range so collisions are common
 * and the deadline tie-break is meaningfully exercised.
 */
const queueInputArb = (): fc.Arbitrary<{ drafts: DraftLike[]; insights: InsightLike[] }> =>
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 16 })
    .chain((ids) =>
      fc.tuple(
        ...ids.map((id) =>
          fc.record({
            id: fc.constant(id),
            isInsight: fc.boolean(),
            draftStatus: draftStatusArb(),
            insightStatus: insightStatusArb(),
            title: fc.string({ maxLength: 12 }),
            createdAt: isoArb(),
            deadlineAt: isoOrNullArb(),
            // Negative + zero + positive to mimic real priorityIndex values.
            priorityIndex: fc.integer({ min: -3, max: 5 }),
          }),
        ),
      ),
    )
    .map((rows) => {
      const drafts: DraftLike[] = [];
      const insights: InsightLike[] = [];
      for (const r of rows) {
        if (r.isInsight) {
          insights.push({
            id: r.id,
            insightStatus: r.insightStatus,
            title: r.title,
            createdAt: r.createdAt,
            deadlineAt: r.deadlineAt,
            priorityIndex: r.priorityIndex,
          });
        } else {
          drafts.push({
            id: r.id,
            status: r.draftStatus,
            title: r.title,
            createdAt: r.createdAt,
            deadlineAt: r.deadlineAt,
            priorityIndex: r.priorityIndex,
          });
        }
      }
      return { drafts, insights };
    });

describe('ai-reporting-and-ops-enhancements approval-queue ordering properties', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 14: Approval_Queue hiển thị theo thứ tự ưu tiên đã lưu
  // Với mọi tập mục Approval_Queue có priorityIndex, danh sách kết xuất bởi buildApprovalQueue được
  // sắp theo priorityIndex không giảm dần (ưu tiên thủ công trước, rồi mới đến tiêu chí deadline hiện có).
  // Validates: Requirements 10.3
  it('Property 14: buildApprovalQueue renders items by non-decreasing priorityIndex, then deadline', () => {
    fc.assert(
      fc.property(queueInputArb(), ({ drafts, insights }) => {
        const queue = buildApprovalQueue(drafts, insights);

        // Membership: exactly the DRAFT drafts ∪ PENDING_REVIEW insights reach the
        // queue (composition is unchanged by the new ordering key).
        const expectedIds = new Set<string>([
          ...drafts.filter((d) => d.status === 'DRAFT').map((d) => d.id),
          ...insights.filter((i) => i.insightStatus === 'PENDING_REVIEW').map((i) => i.id),
        ]);
        expect(queue.length).toBe(expectedIds.size);
        expect(new Set(queue.map((q) => q.id))).toEqual(expectedIds);

        // Primary property (Req 10.3): the manual priorityIndex is non-decreasing
        // across the rendered queue — saved priority is honoured first.
        for (let i = 1; i < queue.length; i++) {
          expect(queue[i].priorityIndex).toBeGreaterThanOrEqual(queue[i - 1].priorityIndex);
        }

        // Full ordering is consistent with the comparator: every adjacent pair is
        // in order (manual priority first, the pre-existing deadline criteria as
        // the tie-breaker within an equal priorityIndex).
        for (let i = 1; i < queue.length; i++) {
          expect(compareApprovalItems(queue[i - 1], queue[i])).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
