/**
 * Admission_Band — pure, framework-free, deterministic Reach/Match/Safety
 * banding for study-abroad programs (study-abroad-ai-advisor-suite, Group 1).
 *
 * Given an admission-likelihood score (from `admissionScorer.ts`) and a
 * program's selectivity tier, it classifies the program into exactly one of
 * REACH | MATCH | SAFETY, or passes through `'INSUFFICIENT_DATA'` when the
 * score is the missing-data label.
 *
 * Design constraints (Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 19.2):
 *  - Exactly one band is assigned for a numeric score in [0, 1] (Req 3.1).
 *  - Deterministic: same score + same selectivity → same band (Req 3.2).
 *  - Selectivity-aware: HIGH selectivity programs require a HIGHER score to
 *    reach the same band than LOW selectivity programs; two programs with the
 *    same score but different selectivity may receive different bands, all
 *    deterministically (Req 3.6).
 *  - Monotonic in score at fixed selectivity: a higher score never yields a
 *    LESS favourable band (SAFETY ≻ MATCH ≻ REACH) — Req 3.5.
 *  - `'INSUFFICIENT_DATA'` (score missing/unreliable) passes through unbanded
 *    rather than being assigned a REACH/MATCH/SAFETY band (Req 3.4, 3.7).
 *
 * This module imports ONLY the shared `./types` projections — no Prisma /
 * Fastify — so it stays directly property-testable (mirrors
 * `admissionScorer`/`scholarshipMatcher`).
 */

import type { AdmissionBandValue, SelectivityTier } from './types';

/**
 * Selectivity-dependent band cutoffs (Req 3.6). A score is classified as:
 *   - `SAFETY` when `score >= safety`,
 *   - else `MATCH` when `score >= match`,
 *   - else `REACH`.
 *
 * Within each tier `safety > match`, which guarantees the score→band mapping is
 * monotonic non-decreasing in score (Req 3.5): raising the score can only move a
 * program to an equal-or-more-favourable band, never a less-favourable one.
 *
 * Across tiers, the cutoffs are strictly ordered HIGH > MEDIUM > LOW on BOTH
 * thresholds, so a more selective program needs a higher score to earn the same
 * band (Req 3.6). The exact numbers chosen:
 *
 *   | Tier   | match cutoff | safety cutoff |
 *   |--------|--------------|---------------|
 *   | HIGH   | 0.60         | 0.85          |
 *   | MEDIUM | 0.45         | 0.75          |
 *   | LOW    | 0.30         | 0.60          |
 *
 * Example: a score of 0.62 is `SAFETY` at LOW selectivity, `MATCH` at MEDIUM,
 * and `MATCH` at HIGH; a score of 0.50 is `MATCH` at LOW, `MATCH` at MEDIUM, and
 * `REACH` at HIGH — demonstrating that the same score lands in a less favourable
 * band as selectivity rises.
 */
export const BAND_CUTOFFS: Readonly<Record<SelectivityTier, { safety: number; match: number }>> = {
  HIGH: { safety: 0.85, match: 0.6 },
  MEDIUM: { safety: 0.75, match: 0.45 },
  LOW: { safety: 0.6, match: 0.3 },
} as const;

/**
 * Resolve a (possibly missing/invalid) selectivity tier to a concrete tier,
 * treating anything that is not a known tier as `MEDIUM` (Req 3.6).
 */
function resolveTier(selectivity: SelectivityTier | null | undefined): SelectivityTier {
  if (selectivity === 'HIGH' || selectivity === 'MEDIUM' || selectivity === 'LOW') {
    return selectivity;
  }
  return 'MEDIUM';
}

/**
 * Classify an admission-likelihood score into exactly one Reach/Match/Safety
 * band, or pass through `'INSUFFICIENT_DATA'`.
 *
 * Behaviour:
 *  - When `score` is the `'INSUFFICIENT_DATA'` label, it passes through
 *    unbanded (Req 3.4, 3.7).
 *  - A non-finite numeric score (NaN/±Infinity) is a data-quality problem and
 *    is reported as `'INSUFFICIENT_DATA'` rather than fabricating a band
 *    (Req 3.7).
 *  - A finite numeric score is clamped into [0, 1] and compared against the
 *    tier's cutoffs (Req 3.1). Clamping is monotonic and the cutoff comparison
 *    is monotonic, so the overall mapping is monotonic non-decreasing in score
 *    at fixed selectivity (Req 3.5).
 *  - Missing/invalid `selectivity` is treated as `MEDIUM` (Req 3.6).
 *
 * Pure + deterministic: same `(score, selectivity)` always yields the same
 * result (Req 3.2).
 */
export function classifyBand(
  score: number | 'INSUFFICIENT_DATA',
  selectivity: SelectivityTier | null | undefined,
): AdmissionBandValue | 'INSUFFICIENT_DATA' {
  // Passthrough the missing-data label without assigning a band (Req 3.4, 3.7).
  if (score === 'INSUFFICIENT_DATA') {
    return 'INSUFFICIENT_DATA';
  }

  // Defensive: a non-finite numeric score signals a data-quality issue, so it
  // is reported as INSUFFICIENT_DATA rather than banded (Req 3.7).
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return 'INSUFFICIENT_DATA';
  }

  // Clamp into [0, 1] before comparing; clamping preserves monotonicity (Req 3.5).
  const bounded = Math.max(0, Math.min(1, score));
  const cutoffs = BAND_CUTOFFS[resolveTier(selectivity)];

  if (bounded >= cutoffs.safety) return 'SAFETY';
  if (bounded >= cutoffs.match) return 'MATCH';
  return 'REACH';
}

/**
 * Rank a band for monotonicity comparison: `SAFETY` (2) ≻ `MATCH` (1) ≻
 * `REACH` (0). A higher score must never lower this rank at fixed selectivity
 * (Req 3.5).
 */
export function bandRank(band: AdmissionBandValue): number {
  switch (band) {
    case 'SAFETY':
      return 2;
    case 'MATCH':
      return 1;
    case 'REACH':
      return 0;
  }
}
