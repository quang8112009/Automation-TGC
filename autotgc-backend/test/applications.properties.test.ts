/**
 * Property-based tests for the study-abroad-ai-advisor-suite spec — the pure
 * `Timeline_Computer` core (`src/applications/timelineComputer.ts`).
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: study-abroad-ai-advisor-suite, Property {n}: {exact design text}`)
 * and runs >= 100 generated cases on fast-check. The module under test is pure
 * (no Prisma/Fastify), so no fakes are required — generated `DueItem` arrays and
 * an injected reference instant make every run deterministic and cheap.
 *
 * Mirrors the structure of `analytics-feedback.properties.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computeTimeline, nextDue } from '../src/applications/timelineComputer';
import type { DueItem } from '../src/applications/types';

// --- generators --------------------------------------------------------------

/**
 * Body of a `DueItem` WITHOUT its `id`. Ids are assigned by index downstream so
 * they are unique by construction (no risk of accidental duplicate tags).
 *
 * - `dueAt`: either `null` (undetermined deadline) or a `Date` built from a
 *   generated epoch-ms — exercises both the dated and undated ordering paths.
 * - `caseType`: one of the two domain owners (`APPLICATION` | `VISA`).
 * - `done`: drives the `nextDue` not-done filter.
 */
const dueItemBodyArb: fc.Arbitrary<Omit<DueItem, 'id'>> = fc.record({
  caseId: fc.string({ maxLength: 8 }),
  caseType: fc.constantFrom<'APPLICATION' | 'VISA'>('APPLICATION', 'VISA'),
  code: fc.string({ maxLength: 6 }),
  label: fc.string({ maxLength: 12 }),
  dueAt: fc.option(
    fc.integer({ min: 0, max: 4_000_000_000_000 }).map((ms) => new Date(ms)),
    { nil: null },
  ),
  done: fc.boolean(),
});

/**
 * Arrays of `DueItem` with UNIQUE ids (assigned by index). Includes the
 * empty array and, across runs, all-`null` deadlines (Req 14.6).
 */
const dueItemsArb: fc.Arbitrary<DueItem[]> = fc
  .array(dueItemBodyArb, { maxLength: 30 })
  .map((bodies) => bodies.map((body, i) => ({ id: `item_${i}`, ...body })));

/** Reference instant for the timeline. */
const nowArb: fc.Arbitrary<Date> = fc
  .integer({ min: 0, max: 4_000_000_000_000 })
  .map((ms) => new Date(ms));

// =============================================================================
// Timeline_Computer property
// =============================================================================

describe('study-abroad-ai-advisor-suite properties (timeline)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 6: Dòng thời gian bảo toàn tập, xác định, sắp hạn tăng dần với hạn-undefined xếp cuối
  it('Property 6: timeline preserves the set, is deterministic, sorts deadlines ascending with undated items last', () => {
    fc.assert(
      fc.property(dueItemsArb, nowArb, (items, now) => {
        const result = computeTimeline(items, now);

        // --- set-preservation: output is a permutation of the input (Req 14.3) ---
        const inputIds = items.map((it) => it.id);
        const outputIds = result.map((it) => it.id);
        expect(outputIds.length).toBe(inputIds.length); // length equal
        expect([...outputIds].sort()).toEqual([...inputIds].sort()); // same multiset of ids
        for (const id of inputIds) {
          // every input id present exactly once (ids are unique by construction)
          expect(outputIds.filter((x) => x === id).length).toBe(1);
        }

        // --- dated items: order is non-decreasing by dueAt time (Req 14.4) ---
        const dated = result.filter((it) => it.dueAt !== null);
        for (let i = 1; i < dated.length; i++) {
          const prev = dated[i - 1].dueAt as Date;
          const cur = dated[i].dueAt as Date;
          expect(prev.getTime()).toBeLessThanOrEqual(cur.getTime());
        }

        // --- every undated (dueAt === null) item appears after every dated item (Req 14.5) ---
        const firstNullIdx = result.findIndex((it) => it.dueAt === null);
        if (firstNullIdx !== -1) {
          for (let i = firstNullIdx; i < result.length; i++) {
            // once a null deadline appears, everything after it is also null
            expect(result[i].dueAt).toBeNull();
          }
        }
        // (all-null input is accepted and still yields a permutation — covered by
        //  the checks above whenever the generator produces an all-null array, Req 14.6.)

        // --- determinism: calling twice yields identical id order (Req 14.2) ---
        const result2 = computeTimeline(items, now);
        expect(result2.map((it) => it.id)).toEqual(outputIds);

        // --- nextDue never returns a done item, and equals the first not-done
        //     item of the timeline order (Req 14.7) ---
        const nd = nextDue(items, now);
        const firstNotDone = result.find((it) => !it.done);
        if (nd === undefined) {
          expect(firstNotDone).toBeUndefined();
        } else {
          expect(nd.done).toBe(false);
          expect(nd.id).toBe(firstNotDone?.id);
        }
      }),
      { numRuns: 100 },
    );
  });
});
