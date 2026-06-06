/**
 * Admission_Scorer — pure, framework-free, deterministic admission-likelihood
 * scoring for study-abroad programs (study-abroad-ai-advisor-suite, Group 1).
 *
 * Given a candidate's normalized academic signals and a program's published
 * thresholds (plus the program's finance picture), it estimates an admission
 * likelihood in the closed interval [0, 1], or `'INSUFFICIENT_DATA'` when the
 * required academic signals are missing — never emitting a misleading number.
 *
 * Design constraints (Requirements 2.1–2.8, 19.1):
 *  - Pure + deterministic: same input → same output (Req 2.2).
 *  - Result is always within [0, 1] when numeric, never NaN/Infinity (Req 2.1).
 *  - GPA normalization runs ONLY when `gpaScale > 0` (precondition Req 2.4, 2.6);
 *    otherwise the GPA dimension is treated as missing — no division by zero.
 *  - Aggregates academic threshold dimensions (normalized GPA, IELTS, TOEFL,
 *    JLPT) plus a financial-fit dimension reused from `scholarshipMatcher`
 *    (Req 2.3) — financial cost is NOT recomputed here.
 *  - A dimension that MEETS its threshold contributes a non-negative score
 *    proportional to how far it exceeds the threshold (Req 2.7); a dimension
 *    that FAILS contributes 0 and cannot be raised by other dimensions
 *    exceeding their own thresholds (Req 2.8) — contributions are independent
 *    per dimension and then averaged.
 *  - If ALL academic signals required to score the program's threshold
 *    dimensions are missing → `'INSUFFICIENT_DATA'` (Req 2.5).
 *
 * This module imports ONLY the pure `scholarshipMatcher` types/functions — no
 * Prisma/Fastify — so it stays directly property-testable (mirrors
 * `scholarshipMatcher`/`destinationMatcher`).
 */

import type { StudentFinance, ProgramFinance } from '../partners/scholarshipMatcher';
import { scoreFinance } from '../partners/scholarshipMatcher';
import type { AcademicSignals, ProgramThresholds } from './types';

/** Small epsilon to guard denominators against divide-by-zero. */
const EPSILON = 1e-9;

/** Base contribution awarded to a dimension that sits exactly at its threshold. */
const THRESHOLD_BASE = 0.5;

/** JLPT levels in ascending proficiency order: N5 < N4 < N3 < N2 < N1. */
const JLPT_ORDER: Readonly<Record<string, number>> = {
  N5: 1,
  N4: 2,
  N3: 3,
  N2: 4,
  N1: 5,
};

/** Highest JLPT ordinal (N1), used as the scale max for headroom. */
const JLPT_MAX_ORDINAL = 5;

/** Clamp `n` into [lo, hi]; a non-finite `n` collapses to `lo`. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Parse a JLPT level string (e.g. " n3 ") to its ordinal, or undefined if invalid. */
function jlptOrdinal(level: string | null | undefined): number | undefined {
  if (typeof level !== 'string') return undefined;
  const key = level.trim().toUpperCase();
  return JLPT_ORDER[key];
}

/**
 * Normalize a GPA to [0, 1] using the linear `gpa / gpaScale`, performed ONLY
 * when `gpaScale > 0` (precondition — Req 2.4, 2.6). Returns `undefined` when
 * the GPA dimension is missing/unusable (missing/non-finite gpa, or a
 * non-positive/invalid scale) so callers treat GPA as absent rather than
 * dividing by zero or fabricating a conversion. The result is clamped to [0, 1].
 */
export function normalizeGpa(
  gpa: number | null | undefined,
  gpaScale: number | null | undefined,
): number | undefined {
  // Precondition: a valid, strictly-positive scale is required before dividing.
  if (typeof gpaScale !== 'number' || !Number.isFinite(gpaScale) || gpaScale <= 0) {
    return undefined;
  }
  if (typeof gpa !== 'number' || !Number.isFinite(gpa)) {
    return undefined;
  }
  return clamp(gpa / gpaScale, 0, 1);
}

/**
 * Score one threshold dimension. Returns a value in [0, 1]: `0` when the
 * candidate is below the threshold (Req 2.8), otherwise a non-negative score
 * that grows with how far the candidate exceeds the threshold (Req 2.7),
 * starting from a small base at exactly the threshold.
 */
function dimensionScore(have: number, min: number, scaleMax: number): number {
  if (have < min) return 0;
  const span = Math.max(EPSILON, scaleMax - min);
  const headroom = (have - min) / span;
  return clamp(THRESHOLD_BASE + (1 - THRESHOLD_BASE) * headroom, 0, 1);
}

/**
 * Derive a financial-fit value in [0, 1] from the reused `scoreFinance` result,
 * or `undefined` when affordability cannot be assessed (no published cost data
 * or no student budget). Reuses `scholarshipMatcher` — does NOT recompute cost.
 */
function financialFit(student: StudentFinance, program: ProgramFinance): number | undefined {
  const hasCost =
    (program.tuitionPerYearVndM ?? 0) > 0 || (program.livingCostPerYearVndM ?? 0) > 0;
  if (!hasCost) return undefined;

  const budget = student.budgetPerYearVndM ?? 0;
  if (!(budget > 0)) return undefined; // cannot assess affordability without a budget

  const fin = scoreFinance(student, program);
  const net = fin.netCostPerYearVndM;
  if (!Number.isFinite(net)) return undefined;
  if (net <= 0) return 1; // scholarship/zero net cost → fully affordable

  // 1 when affordable (shortfall 0), shrinking toward 0 as the shortfall grows.
  return clamp(1 - fin.shortfallVndM / Math.max(EPSILON, net), 0, 1);
}

/**
 * Estimate the admission likelihood for one (academic signals, program
 * thresholds) pair, in [0, 1], or `'INSUFFICIENT_DATA'`.
 *
 * Aggregation: the score is the mean of every per-dimension contribution that
 * can be computed — each declared academic threshold the candidate has a signal
 * for, plus the financial-fit dimension (Req 2.3). Each contribution is bounded
 * in [0, 1] and computed independently, so a failing dimension's `0` is never
 * lifted by another dimension exceeding its threshold (Req 2.7, 2.8). The result
 * is therefore always in [0, 1] and never NaN/Infinity (Req 2.1).
 *
 * `'INSUFFICIENT_DATA'` is returned when no academic threshold dimension can be
 * scored — i.e. the program declares thresholds but the candidate supplies none
 * of the required signals, or the program declares no academic thresholds at all
 * (Req 2.5). The financial dimension alone never rescues this, so missing
 * academic data can never be masked by financial fit.
 *
 * Note: `educationLevel` carries no published program threshold in the model, so
 * it is not scored here (no invented threshold), keeping the function deterministic.
 */
export function scoreAdmission(
  academic: AcademicSignals,
  thresholds: ProgramThresholds,
  finance: { student: StudentFinance; program: ProgramFinance },
): number | 'INSUFFICIENT_DATA' {
  const academicContributions: number[] = [];

  // --- GPA dimension (program publishes minGpa on a 10-scale) ---
  if (thresholds.minGpa != null) {
    const normalizedGpa = normalizeGpa(academic.gpa, academic.gpaScale);
    if (normalizedGpa !== undefined) {
      // Normalize the program's 10-scale minimum into [0, 1] to compare like-for-like.
      const normalizedMin = clamp(thresholds.minGpa / 10, 0, 1);
      academicContributions.push(dimensionScore(normalizedGpa, normalizedMin, 1));
    }
  }

  // --- IELTS dimension (0..9) ---
  if (thresholds.minIelts != null) {
    if (typeof academic.ielts === 'number' && Number.isFinite(academic.ielts)) {
      academicContributions.push(dimensionScore(academic.ielts, thresholds.minIelts, 9));
    }
  }

  // --- TOEFL dimension (0..120) ---
  if (thresholds.minToefl != null) {
    if (typeof academic.toefl === 'number' && Number.isFinite(academic.toefl)) {
      academicContributions.push(dimensionScore(academic.toefl, thresholds.minToefl, 120));
    }
  }

  // --- JLPT dimension (N5 < N4 < N3 < N2 < N1) ---
  const minJlptOrd = jlptOrdinal(thresholds.minJlpt);
  if (minJlptOrd !== undefined) {
    const haveJlptOrd = jlptOrdinal(academic.jlpt);
    if (haveJlptOrd !== undefined) {
      academicContributions.push(dimensionScore(haveJlptOrd, minJlptOrd, JLPT_MAX_ORDINAL));
    }
  }

  // Req 2.5: no academic threshold dimension is scoreable → INSUFFICIENT_DATA.
  if (academicContributions.length === 0) {
    return 'INSUFFICIENT_DATA';
  }

  const contributions = [...academicContributions];

  // Financial-fit dimension reused from scholarshipMatcher (Req 2.3); only
  // contributes when affordability is assessable, and never rescues missing
  // academic data (handled above).
  const finFit = financialFit(finance.student, finance.program);
  if (finFit !== undefined) {
    contributions.push(finFit);
  }

  const sum = contributions.reduce((a, b) => a + b, 0);
  const score = sum / contributions.length;
  return clamp(score, 0, 1);
}
