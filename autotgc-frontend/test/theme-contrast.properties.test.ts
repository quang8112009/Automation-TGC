// Feature: frontend-ui-redesign, Property 5: every theme contrast pair meets WCAG AA
/**
 * Property 5 — Theme contrast AA. Validates Requirements 9.1, 9.2, 13.3.
 *
 * For every (fg, bg, large) pair in AA_PAIRS (the real theme token pairs read
 * from src/styles.css :root), contrastRatio(fg, bg) ≥ 3.0 when `large`, else
 * ≥ 4.5. The contrastRatio helper itself is property-checked: symmetric and
 * always within [1, 21] for random hex inputs.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AA_PAIRS, contrastRatio } from './support/contrast';

// fast-check generator for a #rrggbb hex colour.
const arbHex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, '0')}`);

describe('Property 5: WCAG AA contrast', () => {
  it('every real theme token pair meets its AA threshold', () => {
    // The AA_PAIRS set is fixed (not random), so iterate the whole theme and
    // assert each pair. Done inside fc.property over an index for ≥100 runs that
    // also exercise the helper deterministically.
    fc.assert(
      fc.property(fc.nat({ max: AA_PAIRS.length - 1 }), (i) => {
        const pair = AA_PAIRS[i];
        const ratio = contrastRatio(pair.fg, pair.bg);
        const threshold = pair.large ? 3.0 : 4.5;
        expect(
          ratio,
          `${pair.name} = ${ratio.toFixed(2)} (need ≥ ${threshold})`,
        ).toBeGreaterThanOrEqual(threshold);
      }),
      { numRuns: 200 },
    );

    // Belt-and-braces: also assert the full set directly (every pair, once).
    for (const pair of AA_PAIRS) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(ratio).toBeGreaterThanOrEqual(pair.large ? 3.0 : 4.5);
    }
  });

  it('contrastRatio is symmetric and within [1, 21] for random hex inputs', () => {
    fc.assert(
      fc.property(arbHex, arbHex, (a, b) => {
        const r = contrastRatio(a, b);
        // Symmetry.
        expect(contrastRatio(b, a)).toBeCloseTo(r, 12);
        // Bounds: WCAG ratio lives in [1, 21].
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(21);
        // Identity colours give exactly 1:1.
        expect(contrastRatio(a, a)).toBeCloseTo(1, 12);
      }),
      { numRuns: 300 },
    );
  });
});
