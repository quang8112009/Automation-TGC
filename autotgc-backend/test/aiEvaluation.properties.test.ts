/**
 * Property-based tests for the Evaluation harness (`src/infra/aiEvaluation.ts`),
 * the agent-harness Evaluation layer used to gate the DeepSeek V4 provider
 * migration on output-quality PARITY.
 *
 * The harness is pure, deterministic and numeric-safe, which makes it directly
 * property-testable. We cover the documented invariants of:
 *   - `scoreEvalCase`         — component bounds, grounding coverage, length/non-empty
 *   - `evaluateBatch`         — numeric safety (empty → INSUFFICIENT_DATA) + aggregation
 *   - `compareProviderParity` — delta + tolerance gating, vacuous parity on no data
 *
 * Each property runs fast-check with `{ numRuns: 100 }`.
 *
 * WARNING — these are property-based tests: fast-check explores a fresh random
 * sample on every run (and shrinks counterexamples). A genuine edge-case defect
 * may therefore surface on some runs and not others. A failure prints the
 * minimal failing case + seed; reproduce with that seed rather than re-running
 * until green.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  scoreEvalCase,
  evaluateBatch,
  compareProviderParity,
  type EvalCase,
} from '../src/infra/aiEvaluation';

// --- generators -------------------------------------------------------------

/** Output text: ASCII + Unicode + empty + whitespace-only. */
const outputArb = fc.oneof(
  fc.string(),
  fc.unicodeString(),
  fc.fullUnicodeString(),
  fc.constant(''),
  fc.array(fc.constantFrom(' ', '\t', '\n', '\r', '\f'), { maxLength: 6 }).map((a) => a.join('')),
);

/** Arbitrary keyword list incl. empty + whitespace-only entries (exercise the needle guard). */
const keywordsArb = fc.array(
  fc.oneof(fc.string(), fc.unicodeString(), fc.constant(''), fc.constant('   ')),
  { maxLength: 6 },
);

/**
 * Optional non-negative int bounds; when BOTH are set, normalise so min <= max.
 * Spreading `undefined` values is equivalent to the keys being absent (the source
 * uses `Number.isFinite` to fall back to defaults).
 */
const boundsArb = fc
  .tuple(
    fc.option(fc.nat({ max: 5000 }), { nil: undefined }),
    fc.option(fc.nat({ max: 5000 }), { nil: undefined }),
  )
  .map(([a, b]) => {
    if (a !== undefined && b !== undefined && a > b) return { minChars: b, maxChars: a };
    return { minChars: a, maxChars: b };
  });

/** A fully arbitrary EvalCase. */
const evalCaseArb: fc.Arbitrary<EvalCase> = fc
  .tuple(fc.string(), outputArb, keywordsArb, boundsArb)
  .map(([id, output, expectedKeywords, bounds]) => ({ id, output, expectedKeywords, ...bounds }));

// --- oracles ----------------------------------------------------------------

/** Independent reference for grounding coverage, mirroring the source semantics. */
function expectedCoverage(c: EvalCase): number {
  const kws = c.expectedKeywords ?? [];
  if (kws.length === 0) return 1;
  const hay = (typeof c.output === 'string' ? c.output : '').toLowerCase();
  let hit = 0;
  for (const kw of kws) {
    const needle = (kw ?? '').toLowerCase().trim();
    if (needle.length > 0 && hay.includes(needle)) hit += 1;
  }
  return hit / kws.length;
}

/** True when x is a finite number within [0,1]. */
function inUnitInterval(x: number): boolean {
  return Number.isFinite(x) && x >= 0 && x <= 1;
}

// =============================================================================
// Property 1 — Score component bounds
// =============================================================================

describe('agent-harness — scoreEvalCase component bounds (Property 1)', () => {
  // Feature: agent-harness, Property 1: For ANY EvalCase, every score component (nonEmpty,
  // groundingCoverage, lengthCompliance, overall) is a finite number within [0,1] — never NaN/Infinity.
  it('Property 1: every score component is finite and within [0,1]', () => {
    fc.assert(
      fc.property(evalCaseArb, (c) => {
        const s = scoreEvalCase(c);
        for (const component of [s.nonEmpty, s.groundingCoverage, s.lengthCompliance, s.overall]) {
          expect(Number.isNaN(component)).toBe(false);
          expect(inUnitInterval(component)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 2 — Grounding coverage correctness
// =============================================================================

describe('agent-harness — grounding coverage correctness (Property 2)', () => {
  // Feature: agent-harness, Property 2: With no expected keywords coverage is 1 (nothing to miss).
  it('Property 2a: empty expectedKeywords → groundingCoverage === 1', () => {
    fc.assert(
      fc.property(fc.string(), outputArb, (id, output) => {
        const s = scoreEvalCase({ id, output, expectedKeywords: [] });
        expect(s.groundingCoverage).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 2: When the output contains ALL expected keywords (case-folded),
  // coverage === 1. Output is built by concatenating the keywords (upper-cased) to prove the match is
  // case-insensitive.
  const presentKwArb = fc
    .array(fc.constantFrom('a', 'A', 'b', 'B', 'c', 'C', 'd', 'D', '1', '2'), { minLength: 1, maxLength: 5 })
    .map((cs) => cs.join(''));
  it('Property 2b: output contains all keywords → groundingCoverage === 1', () => {
    fc.assert(
      fc.property(fc.array(presentKwArb, { minLength: 1, maxLength: 6 }), (keywords) => {
        // Upper-case the haystack so a match can only succeed via case-folding.
        const output = keywords.join(' ').toUpperCase();
        const s = scoreEvalCase({ id: 'all', output, expectedKeywords: keywords });
        expect(s.groundingCoverage).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 2: When the output contains NONE of the expected keywords
  // (keywords drawn from an alphabet disjoint from the output), coverage === 0.
  const absentKwArb = fc
    .array(fc.constantFrom(...'abcdefghijklm'.split('')), { minLength: 1, maxLength: 5 })
    .map((cs) => cs.join(''));
  const disjointOutputArb = fc
    .array(fc.constantFrom(...'NOPQRSTUVWXYZ'.split('')), { maxLength: 12 })
    .map((cs) => cs.join(''));
  it('Property 2c: output contains no keywords → groundingCoverage === 0', () => {
    fc.assert(
      fc.property(fc.array(absentKwArb, { minLength: 1, maxLength: 6 }), disjointOutputArb, (keywords, output) => {
        const s = scoreEvalCase({ id: 'none', output, expectedKeywords: keywords });
        expect(s.groundingCoverage).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 2: Coverage equals (#keywords found case-insensitively) / (#keywords).
  it('Property 2d: coverage equals (#found case-insensitively) / (#keywords)', () => {
    fc.assert(
      fc.property(evalCaseArb, (c) => {
        const s = scoreEvalCase(c);
        expect(s.groundingCoverage).toBeCloseTo(expectedCoverage(c), 12);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 3 — nonEmpty + lengthCompliance
// =============================================================================

describe('agent-harness — nonEmpty & lengthCompliance (Property 3)', () => {
  // Feature: agent-harness, Property 3: Empty or whitespace-only output → nonEmpty === 0.
  const blankOutputArb = fc.array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { maxLength: 8 }).map((a) => a.join(''));
  it('Property 3a: empty/whitespace output → nonEmpty === 0', () => {
    fc.assert(
      fc.property(blankOutputArb, keywordsArb, (output, expectedKeywords) => {
        const s = scoreEvalCase({ id: 'blank', output, expectedKeywords });
        expect(s.nonEmpty).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 3: lengthCompliance is 1 iff output length is within
  // [minChars, maxChars], else 0 — tested at the minChars and maxChars boundaries (and just outside).
  it('Property 3b: lengthCompliance is 1 within [minChars,maxChars], 0 outside (boundary-aware)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 50 }), fc.nat({ max: 50 }), fc.nat({ max: 4 }), (min, gap, pick) => {
        const max = min + gap;
        const candidates = [Math.max(0, min - 1), min, Math.floor((min + max) / 2), max, max + 1];
        const len = candidates[pick % candidates.length];
        const output = 'a'.repeat(len);
        const s = scoreEvalCase({ id: 'len', output, expectedKeywords: [], minChars: min, maxChars: max });
        const expected = len >= min && len <= max ? 1 : 0;
        expect(s.lengthCompliance).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 4 — evaluateBatch numeric safety + aggregation
// =============================================================================

describe('agent-harness — evaluateBatch numeric safety (Property 4)', () => {
  // Feature: agent-harness, Property 4: An empty batch is numeric-safe — meanOverall and passRate are
  // 'INSUFFICIENT_DATA', caseCount is 0 and scores is [] regardless of the (clamped) pass threshold.
  it('Property 4a: empty cases → INSUFFICIENT_DATA mean/passRate, caseCount 0, scores []', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 5, noNaN: true }), (threshold) => {
        const report = evaluateBatch([], threshold);
        expect(report.caseCount).toBe(0);
        expect(report.meanOverall).toBe('INSUFFICIENT_DATA');
        expect(report.passRate).toBe('INSUFFICIENT_DATA');
        expect(report.scores).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 4: For a non-empty batch, meanOverall and passRate are numbers in
  // [0,1], scores.length === cases.length, and passRate === (#scores with overall >= threshold)/count.
  it('Property 4b: non-empty batch → bounded mean/passRate, scores aligned, passRate matches threshold', () => {
    fc.assert(
      fc.property(
        fc.array(evalCaseArb, { minLength: 1, maxLength: 20 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (cases, threshold) => {
          const report = evaluateBatch(cases, threshold);

          expect(report.caseCount).toBe(cases.length);
          expect(report.scores.length).toBe(cases.length);

          expect(typeof report.meanOverall).toBe('number');
          expect(typeof report.passRate).toBe('number');
          expect(inUnitInterval(report.meanOverall as number)).toBe(true);
          expect(inUnitInterval(report.passRate as number)).toBe(true);

          const passed = report.scores.filter((s) => s.overall >= threshold).length;
          expect(report.passRate).toBe(passed / report.scores.length);

          const meanExpected = report.scores.reduce((acc, s) => acc + s.overall, 0) / report.scores.length;
          expect(report.meanOverall).toBeCloseTo(meanExpected, 12);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 5 — compareProviderParity
// =============================================================================

describe('agent-harness — compareProviderParity (Property 5)', () => {
  // Cases whose overall == 1 (non-whitespace output, no keywords, within default bounds).
  const goodOutputArb = fc.array(fc.constantFrom('a', 'b', 'c', 'x', '1', '2'), { minLength: 1, maxLength: 12 }).map((a) => a.join(''));
  const goodCaseArb: fc.Arbitrary<EvalCase> = fc.record({
    id: fc.string(),
    output: goodOutputArb,
    expectedKeywords: fc.constant([] as string[]),
  });
  // Cases whose overall == 0 (empty output, an unmet keyword, fails default min length).
  const badCaseArb: fc.Arbitrary<EvalCase> = fc.record({
    id: fc.string(),
    output: fc.constant(''),
    expectedKeywords: fc.constant(['zzz'] as string[]),
  });

  // Feature: agent-harness, Property 5: When either side has no cases, delta is 'INSUFFICIENT_DATA'
  // and parity holds vacuously (withinTolerance === true).
  it('Property 5a: either side empty → delta INSUFFICIENT_DATA and withinTolerance true', () => {
    fc.assert(
      fc.property(
        fc.array(evalCaseArb, { maxLength: 8 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (xs, tolerance) => {
          for (const r of [
            compareProviderParity([], xs, tolerance),
            compareProviderParity(xs, [], tolerance),
            compareProviderParity([], [], tolerance),
          ]) {
            expect(r.delta).toBe('INSUFFICIENT_DATA');
            expect(r.withinTolerance).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 5: With both sides non-empty, delta === meanB - meanA and
  // withinTolerance is true iff meanB >= meanA - tolerance.
  it('Property 5b: both non-empty → delta === meanB - meanA; withinTolerance iff meanB >= meanA - tolerance', () => {
    fc.assert(
      fc.property(
        fc.array(evalCaseArb, { minLength: 1, maxLength: 10 }),
        fc.array(evalCaseArb, { minLength: 1, maxLength: 10 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b, tolerance) => {
          const r = compareProviderParity(a, b, tolerance);
          expect(typeof r.meanA).toBe('number');
          expect(typeof r.meanB).toBe('number');
          const ma = r.meanA as number;
          const mb = r.meanB as number;
          expect(r.delta).toBe(mb - ma);
          expect(r.withinTolerance).toBe(mb >= ma - tolerance);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 5: When B regresses beyond tolerance (meanB=0, meanA=1),
  // withinTolerance === false and delta === -1.
  it('Property 5c: B regresses beyond tolerance → withinTolerance false', () => {
    fc.assert(
      fc.property(
        fc.array(goodCaseArb, { minLength: 1, maxLength: 8 }),
        fc.array(badCaseArb, { minLength: 1, maxLength: 8 }),
        fc.double({ min: 0, max: 0.99, noNaN: true }),
        (a, b, tolerance) => {
          const r = compareProviderParity(a, b, tolerance);
          expect(r.meanA).toBe(1);
          expect(r.meanB).toBe(0);
          expect(r.delta).toBeCloseTo(-1, 12);
          expect(r.withinTolerance).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 5: When B is equal/better (meanB=1, meanA=0),
  // withinTolerance === true and delta === 1.
  it('Property 5d: B equal/better → withinTolerance true', () => {
    fc.assert(
      fc.property(
        fc.array(badCaseArb, { minLength: 1, maxLength: 8 }),
        fc.array(goodCaseArb, { minLength: 1, maxLength: 8 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b, tolerance) => {
          const r = compareProviderParity(a, b, tolerance);
          expect(r.meanA).toBe(0);
          expect(r.meanB).toBe(1);
          expect(r.delta).toBeCloseTo(1, 12);
          expect(r.withinTolerance).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
