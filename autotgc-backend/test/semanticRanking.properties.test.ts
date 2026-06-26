/**
 * Property-based tests for the PURE semantic-ranking helpers
 * (`src/infra/semanticRanking.ts`): `normalizeEmbedding`, `cosineSimilarity`,
 * and `hybridRank`. These underpin the assistant's hybrid keyword+semantic
 * grounding retrieval, so their safety invariants (never throw, neutral score
 * on garbage, deterministic stable ordering, bounded blend) are what keep
 * retrieval from crashing or ranking on corrupt cached embeddings.
 *
 * House style: tests tagged `// Feature: semantic-retrieval, Property {N}`;
 * `{ numRuns: 100 }`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  normalizeEmbedding,
  cosineSimilarity,
  hybridRank,
  type HybridCandidate,
} from '../src/infra/semanticRanking';

const finiteNumber = fc.float({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
const vectorArb = fc.array(finiteNumber, { minLength: 1, maxLength: 16 });

describe('semantic-retrieval — semanticRanking pure helpers', () => {
  // Feature: semantic-retrieval, Property 1: normalizeEmbedding accepts only
  // non-empty arrays of finite numbers; anything else → undefined (treated as
  // "no embedding" so retrieval degrades to keyword).
  it('Property 1: normalizeEmbedding round-trips finite vectors, rejects garbage', () => {
    fc.assert(
      fc.property(vectorArb, (v) => {
        expect(normalizeEmbedding(v)).toEqual(v);
      }),
      { numRuns: 100 },
    );

    expect(normalizeEmbedding([])).toBeUndefined();
    expect(normalizeEmbedding('nope')).toBeUndefined();
    expect(normalizeEmbedding([1, 'x', 3])).toBeUndefined();
    expect(normalizeEmbedding([1, Number.NaN])).toBeUndefined();
    expect(normalizeEmbedding([1, Number.POSITIVE_INFINITY])).toBeUndefined();
    expect(normalizeEmbedding(null)).toBeUndefined();
    expect(normalizeEmbedding(undefined)).toBeUndefined();
  });

  // Feature: semantic-retrieval, Property 2: cosineSimilarity is bounded in
  // [-1,1], never throws, and returns 0 on a length mismatch.
  it('Property 2: cosineSimilarity bounded in [-1,1]; 0 on length mismatch', () => {
    fc.assert(
      fc.property(vectorArb, vectorArb, (a, b) => {
        const sim = cosineSimilarity(a, b);
        expect(Number.isFinite(sim)).toBe(true);
        if (a.length === b.length) {
          expect(sim).toBeGreaterThanOrEqual(-1.0000001);
          expect(sim).toBeLessThanOrEqual(1.0000001);
        } else {
          expect(sim).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: semantic-retrieval, Property 3: a non-zero vector is maximally
  // (≈1) similar to itself.
  it('Property 3: cosineSimilarity(v, v) ≈ 1 for a non-zero vector', () => {
    fc.assert(
      fc.property(
        vectorArb.filter((v) => v.some((x) => x !== 0)),
        (v) => {
          expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: semantic-retrieval, Property 4: a zero-magnitude vector yields a
  // neutral 0 similarity (no divide-by-zero / NaN).
  it('Property 4: zero vector → 0 similarity (no NaN)', () => {
    fc.assert(
      fc.property(vectorArb, (v) => {
        const zero = v.map(() => 0);
        expect(cosineSimilarity(zero, v)).toBe(0);
        expect(cosineSimilarity(v, zero)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: semantic-retrieval, Property 5: hybridRank never returns more than
  // `limit` items, returns a subset of the inputs, and never throws on odd
  // weights/limits.
  it('Property 5: hybridRank bounded by limit, subset of inputs', () => {
    const candArb = fc.array(
      fc.record({
        item: fc.integer(),
        keywordScore: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
        similarity: fc.float({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(candArb, fc.integer({ min: -2, max: 25 }), (cands, limit) => {
        const ranked = hybridRank(cands as HybridCandidate<number>[], limit);
        if (limit > 0) expect(ranked.length).toBeLessThanOrEqual(limit);
        expect(ranked.length).toBeLessThanOrEqual(cands.length);
        const items = new Set(cands.map((c) => c.item));
        for (const r of ranked) expect(items.has(r)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: semantic-retrieval, Property 6: with semantic weight only, the
  // highest-similarity candidate ranks first; ties break by original index.
  it('Property 6: semantic-only weighting ranks by similarity, stable tie-break', () => {
    const cands: HybridCandidate<string>[] = [
      { item: 'a', keywordScore: 0, similarity: 0.1 },
      { item: 'b', keywordScore: 0, similarity: 0.9 },
      { item: 'c', keywordScore: 0, similarity: 0.9 },
    ];
    const ranked = hybridRank(cands, 3, { keyword: 0, semantic: 1 });
    expect(ranked[0]).toBe('b'); // highest similarity, earliest index among ties
    expect(ranked[1]).toBe('c');
    expect(ranked[2]).toBe('a');
  });
});
