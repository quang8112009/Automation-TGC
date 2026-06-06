/**
 * Readiness_Scorer — pure, framework-free, deterministic profile-readiness
 * scoring for study-abroad candidates (study-abroad-ai-advisor-suite, Group 5
 * — "Lộ trình Du học → Nghề nghiệp → Định cư (ROI) + điểm Sẵn sàng hồ sơ").
 *
 * Produces a single readiness score in the closed interval [0, 1] (or
 * `'INSUFFICIENT_DATA'` when no component can be assessed) plus a grounded list
 * of gaps for the missing / under-target components.
 *
 * Design constraints (Requirements 18.1, 18.2, 18.3, 18.4, 18.6; Property 8):
 *  - Pure + deterministic: same input → same output (Req 18.2). No `Date`,
 *    randomness, or I/O.
 *  - The score aggregates AT LEAST the three components below as the MEAN of
 *    the components that are actually PRESENT (Req 18.3):
 *      1. Document completion ratio — REUSES `completionMetric`
 *         (`recruitment/documents/completion.ts`, never reimplemented). When it
 *         returns `'INSUFFICIENT_DATA'` (no required items) this component is
 *         treated as ABSENT.
 *      2. Academic-signal presence — the fraction (∈ [0, 1]) of the expected
 *         academic dimensions the candidate actually supplied. Treated as
 *         ABSENT when the candidate supplied none of them.
 *      3. Language-vs-target — how well the candidate meets the program's
 *         published language target(s) (`minIelts` / `minJlpt`), ∈ [0, 1].
 *         ABSENT when the program publishes no usable language target.
 *  - The result is ALWAYS in [0, 1] when numeric and is never `NaN`/`Infinity`:
 *    every component is individually clamped to [0, 1] before averaging, so
 *    their mean is bounded too (Req 18.1, 18.6).
 *  - If the total number of components used is 0 → `'INSUFFICIENT_DATA'`; NO
 *    division is performed, mirroring the divide-by-zero safety pattern of
 *    `completionMetric` / `analytics/scoring.ts` (Req 18.4).
 *
 * This module imports ONLY the pure `completion` metric and the framework-free
 * admissions types / `gapSuggestion` core — no Prisma/Fastify — so it stays
 * directly property-testable (mirrors `admissionScorer`/`roadmapEstimator`).
 */

import { completionMetric, type ChecklistItemLike } from '../recruitment/documents/completion';
import { suggestGaps } from '../admissions/gapSuggestion';
import type { AcademicSignals, ProgramThresholds, GapItem } from '../admissions/types';

/**
 * The result of scoring a candidate's profile readiness.
 *
 * `score` is in the closed interval [0, 1] when numeric, or `'INSUFFICIENT_DATA'`
 * when no component could be assessed (Req 18.1, 18.4, 18.6). `gaps` is ALWAYS
 * an array — a grounded list of unmet/under-target dimensions (Req 18.5); it
 * stays an array even when `score` is numeric, and may be `[]` (including when
 * `score` is `'INSUFFICIENT_DATA'`).
 */
export interface ReadinessResult {
  score: number | 'INSUFFICIENT_DATA';
  gaps: GapItem[];
}

/** JLPT levels in ascending proficiency order: N5 < N4 < N3 < N2 < N1. */
const JLPT_ORDER: Readonly<Record<string, number>> = {
  N5: 1,
  N4: 2,
  N3: 3,
  N2: 4,
  N1: 5,
};

/**
 * Number of expected academic dimensions used for the academic-signal presence
 * fraction: GPA (usable), language proficiency, and education level.
 */
const ACADEMIC_DIMENSION_COUNT = 3;

/** Narrow an unknown numeric field to a usable finite number. */
function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Clamp `n` into [0, 1]; a non-finite `n` collapses to 0 (never NaN/Infinity). */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Parse a JLPT level string (e.g. " n3 ") to its ordinal, or undefined if invalid. */
function jlptOrdinal(level: string | null | undefined): number | undefined {
  if (typeof level !== 'string') return undefined;
  const key = level.trim().toUpperCase();
  return JLPT_ORDER[key];
}

/**
 * Fraction (∈ [0, 1]) of the expected academic dimensions the candidate has
 * actually supplied, or `undefined` when the candidate supplied NONE (so the
 * component is treated as absent and never forces a misleading 0 into the mean).
 *
 * Expected dimensions (each counts once):
 *  - GPA: usable only when `gpa` is finite AND `gpaScale` is finite and > 0
 *    (mirrors the `normalizeGpa` precondition — no division by a non-positive
 *    scale).
 *  - Language: any one recognized proficiency signal (IELTS, TOEFL, or JLPT).
 *  - Education level: a non-empty `educationLevel` label.
 */
function academicPresence(academic: AcademicSignals): number | undefined {
  let present = 0;

  const gpaUsable =
    isFiniteNumber(academic.gpa) && isFiniteNumber(academic.gpaScale) && academic.gpaScale > 0;
  if (gpaUsable) present += 1;

  const languageProvided =
    isFiniteNumber(academic.ielts) ||
    isFiniteNumber(academic.toefl) ||
    jlptOrdinal(academic.jlpt) !== undefined;
  if (languageProvided) present += 1;

  const educationProvided =
    typeof academic.educationLevel === 'string' && academic.educationLevel.trim().length > 0;
  if (educationProvided) present += 1;

  if (present === 0) return undefined;
  return present / ACADEMIC_DIMENSION_COUNT;
}

/**
 * How well the candidate meets the program's published language target(s),
 * ∈ [0, 1], or `undefined` when the program publishes NO usable language target
 * (then the component is absent — Req 18.3 "trình độ ngôn ngữ so với mục tiêu").
 *
 * Each published target (`minIelts`, `minJlpt`) yields a meet-ratio in [0, 1]
 * (1 when the candidate meets/exceeds it, proportionally less below it, 0 when
 * the candidate supplied no corresponding score). When both are published the
 * component is the mean of the per-target ratios. Denominators are guarded
 * (`minIelts > 0`, valid JLPT level) so the result is never `NaN`/`Infinity`.
 */
function languageVsTarget(
  academic: AcademicSignals,
  thresholds: ProgramThresholds | undefined,
): number | undefined {
  if (!thresholds) return undefined;

  const ratios: number[] = [];

  if (isFiniteNumber(thresholds.minIelts) && thresholds.minIelts > 0) {
    const have = isFiniteNumber(academic.ielts) ? academic.ielts : 0;
    ratios.push(clamp01(have / thresholds.minIelts));
  }

  const minJlptOrd = jlptOrdinal(thresholds.minJlpt);
  if (minJlptOrd !== undefined && minJlptOrd > 0) {
    const haveOrd = jlptOrdinal(academic.jlpt) ?? 0;
    ratios.push(clamp01(haveOrd / minJlptOrd));
  }

  if (ratios.length === 0) return undefined;
  const sum = ratios.reduce((acc, r) => acc + r, 0);
  return clamp01(sum / ratios.length);
}

/**
 * Grounded gap list for the missing / under-target components. Reuses the pure
 * `suggestGaps` core when a program's thresholds are present (gaps cite the
 * program's own thresholds — never fabricated), otherwise `[]`. When
 * `suggestGaps` reports `'INSUFFICIENT_DATA'` it is normalized to `[]` so the
 * `ReadinessResult.gaps` contract stays an array (Req 18.5).
 */
function computeGaps(
  academic: AcademicSignals,
  thresholds: ProgramThresholds | undefined,
): GapItem[] {
  if (!thresholds) return [];
  const result = suggestGaps(academic, thresholds);
  return Array.isArray(result) ? result : [];
}

/**
 * Score a candidate's profile readiness as the MEAN of the components that are
 * present, and surface a grounded gap list. Pure + deterministic (Req 18.2).
 *
 * Components (each ∈ [0, 1], included only when present — Req 18.3):
 *  1. Document completion ratio (reused `completionMetric`; absent when it is
 *     `'INSUFFICIENT_DATA'`).
 *  2. Academic-signal presence fraction (absent when no academic signal given).
 *  3. Language proficiency vs published target (absent when no language target).
 *
 * - The numeric score is always within [0, 1] and never `NaN`/`Infinity`
 *   (Req 18.1, 18.6) — every component is clamped before averaging.
 * - When NO component is present the total component count is 0, so we return
 *   `'INSUFFICIENT_DATA'` WITHOUT dividing (Req 18.4).
 * - `gaps` is always an array (Req 18.5); it may be `[]`, including when the
 *   score is `'INSUFFICIENT_DATA'`.
 */
export function scoreReadiness(input: {
  documents: readonly ChecklistItemLike[];
  academic: AcademicSignals;
  thresholds?: ProgramThresholds;
}): ReadinessResult {
  const { documents, academic, thresholds } = input;

  const components: number[] = [];

  // Component 1 — document completion ratio (REUSES completionMetric).
  const docMetric = completionMetric(documents);
  if (docMetric !== 'INSUFFICIENT_DATA') {
    components.push(clamp01(docMetric));
  }

  // Component 2 — academic-signal presence fraction.
  const presence = academicPresence(academic);
  if (presence !== undefined) {
    components.push(clamp01(presence));
  }

  // Component 3 — language proficiency vs published target.
  const languageFit = languageVsTarget(academic, thresholds);
  if (languageFit !== undefined) {
    components.push(clamp01(languageFit));
  }

  const gaps = computeGaps(academic, thresholds);

  // Req 18.4: no component is assessable → INSUFFICIENT_DATA, no division.
  if (components.length === 0) {
    return { score: 'INSUFFICIENT_DATA', gaps };
  }

  const sum = components.reduce((acc, c) => acc + c, 0);
  const score = clamp01(sum / components.length);
  return { score, gaps };
}
