// Feature: frontend-ui-redesign, Property 7: the class-name contract is preserved
/**
 * Property 7 — Class-contract preservation. Validates Requirements 2.1, 2.3.
 *
 * For every class `cls` in CLASS_CONTRACT, src/styles.css defines at least one
 * rule whose selector matches `cls`. Consequence: no contract class is renamed
 * or has its definition removed, even when temporarily unused.
 *
 * The stylesheet is read from disk and parsed by the pure `definedClasses`
 * helper in test/support/cssClasses.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { definedClasses, CLASS_CONTRACT } from './support/cssClasses';

// Vitest runs with cwd at the project root, so the stylesheet is read relative
// to it (import.meta.url is not a file: URL under the Vite transform).
const cssPath = resolve(process.cwd(), 'src/styles.css');
const css = readFileSync(cssPath, 'utf8');
const defined = definedClasses(css);

describe('Property 7: class-name contract preservation', () => {
  it('extracts a non-trivial set of defined classes', () => {
    expect(defined.size).toBeGreaterThan(50);
    // Sanity: a couple of well-known classes are detected.
    expect(defined.has('card')).toBe(true);
    expect(defined.has('sidebar')).toBe(true);
  });

  it('every class in CLASS_CONTRACT has at least one defining rule', () => {
    fc.assert(
      fc.property(fc.nat({ max: CLASS_CONTRACT.length - 1 }), (i) => {
        const cls = CLASS_CONTRACT[i];
        expect(defined.has(cls), `missing CSS definition for .${cls}`).toBe(true);
      }),
      { numRuns: 200 },
    );

    // Exhaustive sweep so a regression names the exact missing class.
    const missing = CLASS_CONTRACT.filter((cls) => !defined.has(cls));
    expect(missing, `undefined contract classes: ${missing.join(', ')}`).toEqual([]);
  });

  it('a fuzzed class name absent from the stylesheet is reported as undefined', () => {
    fc.assert(
      fc.property(fc.hexaString({ minLength: 6, maxLength: 12 }), (suffix) => {
        const fake = `zz-not-a-real-class-${suffix}`;
        expect(defined.has(fake)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
