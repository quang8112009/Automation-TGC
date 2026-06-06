/**
 * Essays domain types (study-abroad-ai-advisor-suite — Nhóm 2: SOP/Essay/CV).
 *
 * Minimal, framework-free projections (no Prisma/Fastify dependency) so the pure
 * Essay_Reviewer logic can be property-tested directly. Mirrors the design's TS
 * interfaces under "2. Essays".
 */

/** Document kind handled by the essay writer/reviewer (Req 6.1, 6.6). */
export type EssayDocType = 'SOP' | 'MOTIVATION' | 'CV';

/**
 * A single rubric dimension the Essay_Reviewer scores against (Req 7.3):
 *  - structure:        mở bài – thân bài – kết luận rõ ràng
 *  - relevance:        độ liên quan tới chương trình mục tiêu
 *  - lengthCompliance: tuân thủ giới hạn độ dài
 *  - requiredSections: sự hiện diện của các phần bắt buộc
 *
 * `weight` may be 0 and the total may be 0 (the reviewer handles divide-by-zero
 * defensively — Req 7.4). `score` is expected in [0,1] but is clamped defensively.
 */
export interface RubricCriterion {
  key: 'structure' | 'relevance' | 'lengthCompliance' | 'requiredSections';
  /** Relative weight; may be 0. Non-finite/negative weights are treated as 0. */
  weight: number;
  /** Per-criterion score, expected in [0,1]; clamped defensively. */
  score: number;
}

/**
 * Result of reviewing an essay against a rubric.
 * `score` is ALWAYS within the closed interval [0,1], never NaN/Infinity
 * (Req 7.1, 7.6); `feedback` is a deterministic, actionable list (Req 7.2, 7.3).
 */
export interface EssayReview {
  /** Overall weighted score, always in [0,1]. */
  score: number;
  /** Deterministic, actionable feedback derived from low-scoring criteria. */
  feedback: string[];
}

/**
 * Minimal grounding context for the Essay_Writer (task 7.2). Framework-free —
 * carries only the candidate + program fields needed to build a deterministic
 * structured draft. Never carries secrets (Req 6.4).
 */
export interface EssayContext {
  /** Candidate display name (for addressing the draft). */
  candidateName?: string | null;
  /** Candidate's current education level / background, free text. */
  educationLevel?: string | null;
  /** Target program name (e.g. "MSc Computer Science"). */
  programName?: string | null;
  /** Target program country. */
  programCountry?: string | null;
  /** Target field/major of the program. */
  fieldOfStudy?: string | null;
}
