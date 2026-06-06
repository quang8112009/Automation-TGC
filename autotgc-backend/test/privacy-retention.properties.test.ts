/**
 * Property-based tests (fast-check, ≥100 runs each) for pure privacy/retention
 * logic whose invariants were only spot-checked by example before:
 *
 *  - parseRetentionMonths: ALWAYS returns a positive integer; returns the parsed
 *    value for a canonical positive integer string and the fallback for every
 *    non-(positive-integer) input.
 *  - retentionCutoff / isRetained: the boundary is INCLUSIVE — a record exactly
 *    at the cutoff is retained, one instant older is not; and isRetained agrees
 *    with a direct timestamp comparison against retentionCutoff.
 *
 * Pure, deterministic, no network. (Property tests may surface a new edge case
 * on any run; the seed is left to fast-check's default reporting so a failing
 * counterexample is printed.)
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseRetentionMonths } from '../src/privacy/retentionPurgeService';
import { retentionCutoff, isRetained } from '../src/analytics/retention';

describe('parseRetentionMonths — property', () => {
  it('returns the value for a canonical positive-integer string', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1200 }), fc.integer({ min: 1, max: 60 }), (n, fb) => {
        expect(parseRetentionMonths(String(n), fb)).toBe(n);
        // Surrounding whitespace is tolerated (value.trim()).
        expect(parseRetentionMonths(`  ${n}  `, fb)).toBe(n);
      }),
      { numRuns: 200 },
    );
  });

  it('falls back for any non-(positive-integer) input and always yields the fallback exactly', () => {
    const badValue = fc.oneof(
      fc.constant(undefined),
      fc.constant(''),
      fc.constant('   '),
      fc.constant('abc'),
      fc.constant('0'),
      fc.integer({ min: -10_000, max: 0 }).map(String), // <= 0
      fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true }).map(String), // non-integer
      // NOTE: Number('0x10')=16 and Number('1e3')=1000 ARE valid positive
      // integers, so the parser (which uses Number()) accepts them — they are
      // deliberately NOT in this not-a-number set.
      fc.constantFrom('1.5', 'NaN', 'Infinity', '-Infinity', '12px', 'ten'),
    );
    fc.assert(
      fc.property(badValue, fc.integer({ min: 1, max: 60 }), (value, fb) => {
        expect(parseRetentionMonths(value, fb)).toBe(fb);
      }),
      { numRuns: 200 },
    );
  });

  it('the result is always a positive integer regardless of input', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.integer({ min: 1, max: 60 }),
        (value, fb) => {
          const out = parseRetentionMonths(value ?? undefined, fb);
          expect(Number.isInteger(out)).toBe(true);
          expect(out).toBeGreaterThan(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('retentionCutoff / isRetained — inclusive boundary property', () => {
  it('a record exactly AT the cutoff is retained; one ms older is not', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(Date.UTC(2000, 0, 1)), max: new Date(Date.UTC(2100, 0, 1)) }),
        fc.integer({ min: 1, max: 60 }),
        (now, months) => {
          const cutoff = retentionCutoff(now, months);
          // At the boundary -> retained (inclusive).
          expect(isRetained(cutoff, now, months)).toBe(true);
          // One instant before the boundary -> NOT retained.
          const older = new Date(cutoff.getTime() - 1);
          expect(isRetained(older, now, months)).toBe(false);
          // One instant after -> retained.
          const newer = new Date(cutoff.getTime() + 1);
          expect(isRetained(newer, now, months)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('isRetained agrees with a direct comparison against retentionCutoff', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(Date.UTC(2000, 0, 1)), max: new Date(Date.UTC(2100, 0, 1)) }),
        fc.date({ min: new Date(Date.UTC(1990, 0, 1)), max: new Date(Date.UTC(2100, 0, 1)) }),
        fc.integer({ min: 1, max: 60 }),
        (now, recordAt, months) => {
          const cutoff = retentionCutoff(now, months).getTime();
          expect(isRetained(recordAt, now, months)).toBe(recordAt.getTime() >= cutoff);
        },
      ),
      { numRuns: 300 },
    );
  });
});
