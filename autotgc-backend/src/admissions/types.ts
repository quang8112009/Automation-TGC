/**
 * Shared types for the Admissions capability (study-abroad-ai-advisor-suite,
 * Group 1 — admission likelihood scoring + Reach/Match/Safety banding + gap
 * suggestions).
 *
 * These are framework-free projections (no Prisma/Fastify dependency) so the
 * pure scoring/banding/gap modules stay directly property-testable, mirroring
 * the existing `scholarshipMatcher`/`destinationMatcher` modules.
 */

/** Reach/Match/Safety band assigned to a scored program (Req 3.1). */
export type AdmissionBandValue = 'REACH' | 'MATCH' | 'SAFETY';

/** Program selectivity tier; missing → treated as MEDIUM when banding (Req 3.6). */
export type SelectivityTier = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Normalized academic signals for one candidate (projected from
 * `AcademicProfile`, 1–1 with `CandidateProfile`). All optional/nullable — a
 * missing signal means "that dimension is unknown", never a fabricated value
 * (Req 1.1, 2.4, 2.5, 2.6).
 */
export interface AcademicSignals {
  /** Raw GPA value on the `gpaScale` below. */
  gpa?: number | null;
  /** GPA scale (e.g. 10 or 4.0). Normalization precondition: must be > 0 (Req 2.4, 2.6). */
  gpaScale?: number | null;
  /** IELTS overall band, 0..9. */
  ielts?: number | null;
  /** TOEFL iBT total, 0..120. */
  toefl?: number | null;
  /** JLPT level string, N5..N1 (N5 < N4 < N3 < N2 < N1). */
  jlpt?: string | null;
  /** Free-form education level label (e.g. BACHELOR). */
  educationLevel?: string | null;
}

/**
 * Program admission thresholds (projected from `DestinationProgram`). Only the
 * thresholds the program actually publishes are non-null; a missing threshold
 * means "no constraint on that axis" and is never invented (Req 4.2).
 */
export interface ProgramThresholds {
  id: string;
  name: string;
  country: string;
  /** Minimum GPA on a 10-scale (existing column). */
  minGpa?: number | null;
  /** Minimum IELTS overall band (existing column). */
  minIelts?: number | null;
  /** Minimum TOEFL iBT total (additive nullable column). */
  minToefl?: number | null;
  /** Minimum JLPT level, N5..N1 (additive nullable column). */
  minJlpt?: string | null;
  /** Selectivity tier; missing → MEDIUM when banding (additive nullable column). */
  selectivityTier?: SelectivityTier | null;
}

/**
 * A single unmet dimension with the TARGET threshold taken FROM the program
 * (never fabricated — Req 4.1, 4.2) and the candidate's CURRENT value.
 */
export interface GapItem {
  dimension: 'GPA' | 'IELTS' | 'TOEFL' | 'JLPT';
  /** Target threshold as published by the program. */
  target: number | string;
  /** Candidate's current value, or null when the signal is missing. */
  current: number | string | null;
}

/**
 * Full admission result for one (candidate, program) pair: the bounded score,
 * its band, and gap suggestions. Any of these may be `'INSUFFICIENT_DATA'` when
 * the required data is missing rather than emitting a misleading value
 * (Req 2.5, 3.4, 4.4).
 */
export interface AdmissionResult {
  programId: string;
  name: string;
  country: string;
  /** Admission likelihood ∈ [0,1] when numeric, never NaN/Infinity (Req 2.1). */
  score: number | 'INSUFFICIENT_DATA';
  band: AdmissionBandValue | 'INSUFFICIENT_DATA';
  gaps: GapItem[] | 'INSUFFICIENT_DATA';
}
