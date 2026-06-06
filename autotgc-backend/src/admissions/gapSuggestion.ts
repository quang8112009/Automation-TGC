/**
 * Gap_Suggestion — pure, framework-free, deterministic gap suggestions for the
 * Admissions capability (study-abroad-ai-advisor-suite, Group 1).
 *
 * Given a candidate's normalized academic signals and a program's published
 * thresholds, it lists the dimensions where the candidate falls short, citing
 * the TARGET threshold taken straight FROM the program (never fabricated), or
 * returns `'INSUFFICIENT_DATA'` when the program publishes nothing comparable,
 * publishes malformed thresholds, or the candidate signals needed to verify a
 * published threshold are unavailable.
 *
 * Design constraints (Requirements 4.1–4.7, Correctness Property 3):
 *  - Only program-published threshold numbers are used as `target`; no numbers
 *    are invented outside those thresholds (Req 4.1, 4.2).
 *  - Candidate meets every published & verifiable threshold → `[]`
 *    (verified-empty — Req 4.3).
 *  - The program publishes NO comparable thresholds at all → `'INSUFFICIENT_DATA'`
 *    (Req 4.4).
 *  - Threshold data exists but cannot be meaningfully compared (a non-finite
 *    numeric threshold, or an unrecognized `minJlpt` string) → `'INSUFFICIENT_DATA'`
 *    (Req 4.6). A malformed published threshold poisons the whole result rather
 *    than silently dropping a dimension, because the program's threshold data
 *    can no longer be trusted for a complete comparison.
 *  - A published threshold exists on a dimension where the candidate has NO
 *    signal to verify it, and no other dimension produced a concrete gap →
 *    `'INSUFFICIENT_DATA'`, to distinguish "verified empty" from "cannot verify"
 *    (Req 4.7). When at least one concrete gap is found the candidate plainly
 *    does not meet everything, so the actionable gap list is returned instead.
 *  - Pure + deterministic: the same input always yields the same list in the
 *    same order. Dimensions are emitted in the stable order GPA, IELTS, TOEFL,
 *    JLPT (Req 4.5).
 *
 * This module imports ONLY the pure `normalizeGpa` helper and the shared types —
 * no Prisma/Fastify — so it stays directly property-testable (mirrors
 * `admissionScorer`/`scholarshipMatcher`).
 */

import { normalizeGpa } from './admissionScorer';
import type { AcademicSignals, GapItem, ProgramThresholds } from './types';

/** Sentinel returned when no meaningful, verifiable comparison is possible. */
const INSUFFICIENT_DATA = 'INSUFFICIENT_DATA' as const;

/** JLPT levels in ascending proficiency order: N5 < N4 < N3 < N2 < N1. */
const JLPT_ORDER: Readonly<Record<string, number>> = {
  N5: 1,
  N4: 2,
  N3: 3,
  N2: 4,
  N1: 5,
};

/** Parse a JLPT level string (e.g. " n3 ") to its ordinal, or undefined if invalid. */
function jlptOrdinal(level: string | null | undefined): number | undefined {
  if (typeof level !== 'string') return undefined;
  const key = level.trim().toUpperCase();
  return JLPT_ORDER[key];
}

/** True when `n` is a usable finite number. */
function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Internal per-dimension outcome:
 *  - `gap`        → the candidate is verifiably below this published threshold.
 *  - `met`        → the candidate verifiably meets this published threshold.
 *  - `unverifiable` → the threshold is published & valid, but the candidate has
 *                     no signal to verify it (Req 4.7).
 *  - `invalid`    → the published threshold itself is malformed (Req 4.6).
 *  - `absent`     → the program publishes no threshold on this dimension.
 */
type DimensionOutcome =
  | { kind: 'gap'; item: GapItem }
  | { kind: 'met' }
  | { kind: 'unverifiable' }
  | { kind: 'invalid' }
  | { kind: 'absent' };

/** Evaluate the GPA dimension, normalizing the candidate GPA against the 10-scale minGpa. */
function evaluateGpa(academic: AcademicSignals, thresholds: ProgramThresholds): DimensionOutcome {
  if (thresholds.minGpa == null) return { kind: 'absent' };
  // A non-finite published threshold cannot be meaningfully compared (Req 4.6).
  if (!isFiniteNumber(thresholds.minGpa)) return { kind: 'invalid' };

  // Normalize the candidate GPA via gpaScale (precondition gpaScale > 0); an
  // invalid/missing scale leaves the GPA dimension unverifiable (Req 4.7).
  const normalizedGpa = normalizeGpa(academic.gpa, academic.gpaScale);
  if (normalizedGpa === undefined) return { kind: 'unverifiable' };

  // Compare like-for-like on the 10-scale, mirroring admissionScorer.
  const normalizedMin = Math.max(0, Math.min(1, thresholds.minGpa / 10));
  if (normalizedGpa < normalizedMin) {
    return {
      kind: 'gap',
      // target is the program's published 10-scale minimum (never fabricated);
      // current is the candidate's own GPA value.
      item: { dimension: 'GPA', target: thresholds.minGpa, current: academic.gpa ?? null },
    };
  }
  return { kind: 'met' };
}

/** Evaluate a plain numeric dimension (IELTS/TOEFL) where candidate and program share a scale. */
function evaluateNumeric(
  dimension: 'IELTS' | 'TOEFL',
  min: number | null | undefined,
  current: number | null | undefined,
): DimensionOutcome {
  if (min == null) return { kind: 'absent' };
  if (!isFiniteNumber(min)) return { kind: 'invalid' };
  if (!isFiniteNumber(current)) return { kind: 'unverifiable' };
  if (current < min) {
    return { kind: 'gap', item: { dimension, target: min, current } };
  }
  return { kind: 'met' };
}

/** Evaluate the JLPT dimension using ordinal ordering N5 < N4 < N3 < N2 < N1. */
function evaluateJlpt(academic: AcademicSignals, thresholds: ProgramThresholds): DimensionOutcome {
  if (thresholds.minJlpt == null) return { kind: 'absent' };
  const minOrd = jlptOrdinal(thresholds.minJlpt);
  // An unrecognized published JLPT level cannot be meaningfully compared (Req 4.6).
  if (minOrd === undefined) return { kind: 'invalid' };

  const haveOrd = jlptOrdinal(academic.jlpt);
  if (haveOrd === undefined) return { kind: 'unverifiable' };
  if (haveOrd < minOrd) {
    return {
      kind: 'gap',
      // target/current are the published/held level strings (never fabricated).
      item: { dimension: 'JLPT', target: thresholds.minJlpt, current: academic.jlpt ?? null },
    };
  }
  return { kind: 'met' };
}

/**
 * Suggest the dimensions the candidate must improve to satisfy a program's
 * published thresholds, citing each TARGET threshold straight from the program.
 *
 * @returns A deterministic `GapItem[]` (possibly empty when every published &
 *   verifiable threshold is met), or `'INSUFFICIENT_DATA'` when no comparable
 *   threshold is published, a published threshold is malformed, or a published
 *   threshold cannot be verified for lack of candidate data.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7 and Correctness Property 3.
 */
export function suggestGaps(
  academic: AcademicSignals,
  thresholds: ProgramThresholds,
): GapItem[] | 'INSUFFICIENT_DATA' {
  // Evaluate dimensions in the stable, deterministic order: GPA, IELTS, TOEFL, JLPT (Req 4.5).
  const outcomes: DimensionOutcome[] = [
    evaluateGpa(academic, thresholds),
    evaluateNumeric('IELTS', thresholds.minIelts, academic.ielts),
    evaluateNumeric('TOEFL', thresholds.minToefl, academic.toefl),
    evaluateJlpt(academic, thresholds),
  ];

  // Any malformed published threshold means the program's threshold data cannot
  // be meaningfully compared as a whole → INSUFFICIENT_DATA (Req 4.6).
  if (outcomes.some((o) => o.kind === 'invalid')) {
    return INSUFFICIENT_DATA;
  }

  // The program publishes no comparable threshold on any dimension → INSUFFICIENT_DATA (Req 4.4).
  const publishedCount = outcomes.filter((o) => o.kind !== 'absent').length;
  if (publishedCount === 0) {
    return INSUFFICIENT_DATA;
  }

  // Collect concrete gaps in dimension order (Req 4.1, 4.5).
  const gaps: GapItem[] = outcomes
    .filter((o): o is { kind: 'gap'; item: GapItem } => o.kind === 'gap')
    .map((o) => o.item);

  if (gaps.length > 0) {
    // At least one verified shortfall: return the actionable list (Req 4.1).
    return gaps;
  }

  // No concrete gap. If a published threshold could not be verified, we cannot
  // claim a verified-empty result → INSUFFICIENT_DATA distinguishes the two (Req 4.7).
  if (outcomes.some((o) => o.kind === 'unverifiable')) {
    return INSUFFICIENT_DATA;
  }

  // Every published threshold was verified and met → verified-empty (Req 4.3).
  return [];
}
