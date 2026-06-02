/**
 * Property-based tests for the shared drag-and-drop reorder logic
 * (ai-reporting-and-ops-enhancements spec — tasks 6.2 & 6.3).
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: ai-reporting-and-ops-enhancements, Property {n}: ...`) and runs
 * >= 100 generated cases on fast-check. The logic under test is pure, so no
 * fakes/mocks are required.
 *
 * This file is intentionally separate from `ai-reporting-and-ops.properties.test.ts`
 * to avoid collisions while the rest of that suite is being built out.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { applyReorder } from '../src/content/reorder';
import type { Reorderable, ReorderRequest } from '../src/content/reorder';

interface Item extends Reorderable {
  id: string;
  orderIndex: number;
  // An extra payload field to assert other properties are preserved untouched.
  payload: number;
}

/** Generate a set of items with unique ids and arbitrary starting orderIndex. */
const itemsArb = (): fc.Arbitrary<Item[]> =>
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 0, maxLength: 12 })
    .chain((ids) =>
      fc.tuple(
        ...ids.map((id) =>
          fc.record({
            id: fc.constant(id),
            orderIndex: fc.integer({ min: -50, max: 50 }),
            payload: fc.integer({ min: 0, max: 1000 }),
          }),
        ),
      ),
    )
    .map((rows) => rows as Item[]);

/**
 * Generate a ReorderRequest for the given items. The orderedIds are a shuffled
 * subset of the item ids (a realistic drag-and-drop payload). For Property 13 we
 * also allow unknown/duplicate ids to prove idempotence holds regardless.
 */
const requestArb = (items: Item[], allowNoise: boolean): fc.Arbitrary<ReorderRequest> => {
  const ids = items.map((i) => i.id);
  const subset = fc.shuffledSubarray(ids);
  if (!allowNoise) {
    return subset.map((orderedIds) => ({ orderedIds }));
  }
  return fc
    .tuple(
      subset,
      fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 4 }), // possibly-unknown ids
    )
    .chain(([chosen, extra]) =>
      // Re-shuffle the combination so duplicates/unknowns can land anywhere.
      fc.shuffledSubarray([...chosen, ...chosen, ...extra], { minLength: 0 }).map((orderedIds) => ({
        orderedIds,
      })),
    );
};

describe('ai-reporting-and-ops-enhancements reorder properties', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 12: Reorder bảo toàn tập hợp và phản ánh đúng thứ tự
  // Với mọi tập mục có thể sắp xếp và mọi Reorder_Request hợp lệ, applyReorder trả về một tập có
  // cùng tập id với đầu vào (không thêm, không mất mục), và orderIndex/priorityIndex của mỗi mục
  // có mặt trong orderedIds bằng đúng vị trí của nó trong orderedIds.
  // Validates: Requirements 9.2, 9.3, 10.1, 10.2
  it('Property 12: reorder preserves the id set and reflects orderedIds positions', () => {
    fc.assert(
      fc.property(
        itemsArb().chain((items) => requestArb(items, false).map((req) => [items, req] as const)),
        ([items, req]) => {
          const result = applyReorder(items, req);

          // Set preservation: same multiset of ids, no additions/removals.
          expect(result.length).toBe(items.length);
          expect([...result.map((r) => r.id)].sort()).toEqual([...items.map((i) => i.id)].sort());

          // Other fields are preserved for each id (only orderIndex changes).
          const payloadById = new Map(items.map((i) => [i.id, i.payload]));
          for (const r of result) {
            expect(r.payload).toBe(payloadById.get(r.id));
          }

          // orderIndex equals the item's position in the produced ordering, and the
          // positions are exactly 0..n-1 with no gaps/dupes.
          result.forEach((r, idx) => expect(r.orderIndex).toBe(idx));

          // Each id present in orderedIds gets orderIndex equal to its position in
          // orderedIds (the request has no duplicates/unknowns in this property).
          req.orderedIds.forEach((id, position) => {
            const found = result.find((r) => r.id === id);
            expect(found).toBeDefined();
            expect(found?.orderIndex).toBe(position);
          });

          // Ids absent from orderedIds are placed after all requested ids.
          const requested = new Set(req.orderedIds);
          const firstUnrequestedIndex = result.findIndex((r) => !requested.has(r.id));
          if (firstUnrequestedIndex !== -1) {
            expect(firstUnrequestedIndex).toBe(req.orderedIds.length);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: ai-reporting-and-ops-enhancements, Property 13: Reorder là phép toán lũy đẳng
  // Với mọi tập mục và mọi Reorder_Request, áp dụng applyReorder hai lần liên tiếp cho cùng kết quả
  // như áp dụng một lần: applyReorder(applyReorder(items, req), req) bằng applyReorder(items, req).
  // Validates: Requirements 10.4
  it('Property 13: reorder is idempotent (even with unknown/duplicate ids)', () => {
    fc.assert(
      fc.property(
        itemsArb().chain((items) => requestArb(items, true).map((req) => [items, req] as const)),
        ([items, req]) => {
          const once = applyReorder(items, req);
          const twice = applyReorder(once, req);
          expect(twice).toEqual(once);
        },
      ),
      { numRuns: 200 },
    );
  });
});
