/**
 * Property-based tests for the deepseek-v4-model-migration spec.
 *
 * Covers the AI-OPTIONAL invariant guard `enforceAiGeneratedFlag` (pure helper
 * in `src/infra/aiOptional.ts`). Each test is tagged with its DESIGN-canonical
 * property number/text and runs >= 100 generated cases on fast-check.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { enforceAiGeneratedFlag } from '../src/infra/aiOptional';

// Arbitrary "extra" fields that ride alongside the required `aiGenerated` flag.
// We exclude `aiGenerated` (and `__proto__`, which spread/assignment treats
// specially) so the generated extras never collide with the guarded flag.
const extraFields = fc.dictionary(
  fc.string().filter((k) => k !== 'aiGenerated' && k !== '__proto__'),
  fc.anything(),
);

// A result object carrying a random `aiGenerated` boolean plus arbitrary extras.
const resultArb = fc.tuple(extraFields, fc.boolean()).map(([extra, aiGenerated]) => ({
  ...extra,
  aiGenerated,
}));

describe('deepseek-v4-model-migration properties (aiOptional)', () => {
  // Feature: deepseek-v4-model-migration, Property 9: Hàm guard cờ aiGenerated
  // For any result and source: enforceAiGeneratedFlag(result, 'FALLBACK') always
  // yields aiGenerated = false; while enforceAiGeneratedFlag(result, 'AI') keeps
  // the result's original flag unchanged.
  it('Property 9: FALLBACK always forces aiGenerated=false; AI preserves the flag', () => {
    fc.assert(
      fc.property(resultArb, (result) => {
        const inputFlag = result.aiGenerated;

        // FALLBACK: the output flag is ALWAYS false, regardless of the input.
        const fallback = enforceAiGeneratedFlag(result, 'FALLBACK');
        expect(fallback.aiGenerated).toBe(false);

        // AI: the input's aiGenerated flag is preserved unchanged.
        const ai = enforceAiGeneratedFlag(result, 'AI');
        expect(ai.aiGenerated).toBe(inputFlag);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 9: Hàm guard cờ aiGenerated
  // Other (non-flag) fields are always preserved by the guard, and the
  // FALLBACK-from-true case returns a NEW object without mutating the input.
  it('Property 9: preserves other fields and does not mutate the input', () => {
    fc.assert(
      fc.property(resultArb, (result) => {
        // Snapshot of the non-flag fields before calling the guard.
        const otherKeys = Object.keys(result).filter((k) => k !== 'aiGenerated');
        const snapshotOthers = () =>
          Object.fromEntries(otherKeys.map((k) => [k, (result as Record<string, unknown>)[k]]));
        const before = snapshotOthers();
        const inputFlag = result.aiGenerated;

        // --- FALLBACK branch -------------------------------------------------
        const fallback = enforceAiGeneratedFlag(result, 'FALLBACK');
        // All non-flag fields are carried over unchanged.
        for (const k of otherKeys) {
          expect((fallback as Record<string, unknown>)[k]).toStrictEqual(before[k]);
        }
        // The input object is never mutated by the guard.
        expect(result.aiGenerated).toBe(inputFlag);
        expect(snapshotOthers()).toStrictEqual(before);

        if (inputFlag === true) {
          // FALLBACK-from-true must return a fresh object (shallow copy), not the
          // same reference, with the flag corrected to false.
          expect(fallback).not.toBe(result);
          expect(fallback.aiGenerated).toBe(false);
        } else {
          // FALLBACK-from-false has nothing to fix: same reference returned.
          expect(fallback).toBe(result);
        }

        // --- AI branch -------------------------------------------------------
        const ai = enforceAiGeneratedFlag(result, 'AI');
        // AI never rewrites anything: same reference, all fields intact.
        expect(ai).toBe(result);
        for (const k of otherKeys) {
          expect((ai as Record<string, unknown>)[k]).toStrictEqual(before[k]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
