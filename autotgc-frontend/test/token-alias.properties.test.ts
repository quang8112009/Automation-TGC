// Feature: frontend-ui-redesign, Property 6: alias tokens always resolve to a valid base
/**
 * Property 6 — Token alias resolution. Validates Requirement 4.4.
 *
 * For every alias token in the :root block of src/styles.css (a token whose
 * value references another via var(--…)), resolving the var() chain terminates
 * at a base token with a literal value — no dangling references, no cycles.
 *
 * The stylesheet is read from disk and parsed by the pure `parseRootTokens` /
 * `resolveToken` helpers in test/support/cssTokens.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseRootTokens, resolveToken, isAliasValue } from './support/cssTokens';

// Vitest runs with cwd at the project root, so the stylesheet is read relative
// to it (import.meta.url is not a file: URL under the Vite transform).
const cssPath = resolve(process.cwd(), 'src/styles.css');
const css = readFileSync(cssPath, 'utf8');
const tokenMap = parseRootTokens(css);
const tokenNames = Object.keys(tokenMap);
const aliasNames = tokenNames.filter((name) => isAliasValue(tokenMap[name]));

describe('Property 6: token alias resolution', () => {
  it('the :root block parses into a non-trivial token map with known aliases', () => {
    expect(tokenNames.length).toBeGreaterThan(50);
    // Documented back-compat aliases must be present and alias-shaped.
    for (const alias of ['color-cta', 'gray-500', 'bg', 'primary', 'radius', 'shadow']) {
      expect(tokenMap[alias], `missing token --${alias}`).toBeDefined();
      expect(isAliasValue(tokenMap[alias]), `--${alias} is not an alias`).toBe(true);
    }
    // There must actually be alias tokens to exercise the property.
    expect(aliasNames.length).toBeGreaterThan(0);
  });

  it('every alias token resolves to a literal base — no dangling refs, no cycles', () => {
    fc.assert(
      fc.property(fc.nat({ max: aliasNames.length - 1 }), (i) => {
        const name = aliasNames[i];
        const result = resolveToken(name, tokenMap);
        expect(result.resolved, `--${name} → ${result.reason} (chain: ${result.chain.join(' → ')})`).toBe(true);
        // The terminal value is a non-empty literal that no longer references var().
        expect(result.value.length).toBeGreaterThan(0);
        expect(isAliasValue(result.value)).toBe(false);
      }),
      { numRuns: 200 },
    );

    // Exhaustive sweep: assert every alias directly (every alias, once).
    for (const name of aliasNames) {
      const result = resolveToken(name, tokenMap);
      expect(result.resolved).toBe(true);
      expect(isAliasValue(result.value)).toBe(false);
    }
  });

  it('resolveToken is total: dangling and cyclic maps are reported, never thrown', () => {
    expect(resolveToken('missing', {}).reason).toBe('dangling');
    expect(resolveToken('a', { a: 'var(--b)', b: 'var(--a)' }).reason).toBe('cycle');
  });
});
