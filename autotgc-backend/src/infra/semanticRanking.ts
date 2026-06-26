/**
 * semanticRanking — PURE helpers for embedding-based (semantic) retrieval and
 * hybrid keyword+semantic ranking. Framework-free and deterministic so the
 * whole ranking layer is exhaustively property-testable with fast-check.
 *
 * Design notes that keep this safe to add to the system:
 *  - NEVER throws on malformed input. A length mismatch, a zero-magnitude
 *    vector, NaN/Infinity components, or a non-array embedding all resolve to a
 *    neutral score (0 similarity), so a bad cached embedding can only DEMOTE an
 *    entry, never crash retrieval.
 *  - The hybrid blend NORMALIZES the unbounded keyword score (0..n) against the
 *    batch max into [0,1] and clamps cosine similarity into [0,1], so the two
 *    signals are comparable before the weighted sum.
 *  - Ties break by the candidate's original index (stable), so ranking is
 *    deterministic for identical scores.
 */

/** Default blend weights for hybrid ranking (sum need not be 1; they are relative). */
export const DEFAULT_HYBRID_WEIGHTS: HybridWeights = { keyword: 0.5, semantic: 0.5 };

/** Relative importance of each signal in the hybrid blend. */
export interface HybridWeights {
  keyword: number;
  semantic: number;
}

/**
 * Coerce an unknown (e.g. a Prisma `Json` column) into a finite-number vector.
 * Returns `undefined` when the value is not an array, is empty, or contains any
 * non-finite component — so callers treat a corrupt embedding as "absent" and
 * fall back to keyword ranking rather than ranking on garbage.
 */
export function normalizeEmbedding(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: number[] = [];
  for (const raw of value) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    out.push(raw);
  }
  return out;
}

/**
 * Cosine similarity of two equal-length numeric vectors, in [-1, 1]. Returns 0
 * (a neutral, non-throwing result) when the lengths differ, either vector is
 * empty, or either has zero magnitude. Non-finite intermediate results also
 * collapse to 0.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  return Number.isFinite(sim) ? sim : 0;
}

/** One candidate carrying both signals for the hybrid blend. */
export interface HybridCandidate<T> {
  item: T;
  /** Raw keyword/tag relevance score (>= 0); higher is more relevant. */
  keywordScore: number;
  /** Cosine similarity to the query embedding, in [-1, 1]. */
  similarity: number;
}

/**
 * Blend keyword and semantic signals into a single ranked list. The keyword
 * score is min-max normalized against the batch maximum (so an all-zero keyword
 * batch contributes nothing rather than dividing by zero); similarity is
 * clamped to [0,1]. The combined score is the weighted sum; ties break by
 * original index for stable, deterministic ordering. Returns the top-N items.
 */
export function hybridRank<T>(
  candidates: readonly HybridCandidate<T>[],
  limit: number,
  weights: HybridWeights = DEFAULT_HYBRID_WEIGHTS,
): T[] {
  if (candidates.length === 0) return [];
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : candidates.length;

  const maxKeyword = candidates.reduce((m, c) => (c.keywordScore > m ? c.keywordScore : m), 0);
  const wk = Number.isFinite(weights.keyword) ? weights.keyword : 0;
  const ws = Number.isFinite(weights.semantic) ? weights.semantic : 0;

  const scored = candidates.map((c, index) => {
    const normKeyword = maxKeyword > 0 ? c.keywordScore / maxKeyword : 0;
    const clampedSim = c.similarity < 0 ? 0 : c.similarity > 1 ? 1 : c.similarity;
    const combined = wk * normKeyword + ws * clampedSim;
    return { item: c.item, combined, index };
  });

  scored.sort((p, q) => {
    if (q.combined !== p.combined) return q.combined - p.combined;
    return p.index - q.index;
  });

  return scored.slice(0, n).map((s) => s.item);
}
