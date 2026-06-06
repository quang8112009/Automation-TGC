/**
 * Essay_Reviewer — pure, deterministic rubric scoring for SOP / motivation /
 * CV drafts (study-abroad-ai-advisor-suite — Nhóm 2, Req 7.1–7.6).
 *
 * Framework-free + deterministic so it is property-testable directly (Property 4).
 * The overall score is the WEIGHTED AVERAGE of per-criterion scores and is ALWAYS
 * within the closed interval [0,1], never NaN/Infinity (Req 7.1, 7.6). When the
 * sum of weights is 0 the reviewer returns a default score of 0.0 and CONTINUES
 * (no division, no hard-fail — Req 7.4). Given the same content + same rubric it
 * always yields the same score and the same feedback list (Req 7.2). Feedback is
 * a deterministic, actionable list derived from the criteria that scored low
 * across the rubric dimensions: structure, relevance to the program, length
 * compliance, and required sections (Req 7.3).
 */
import type { EssayDocType, RubricCriterion, EssayReview } from './types';

/** A criterion at or below this score is flagged as needing improvement. */
const LOW_SCORE_THRESHOLD = 0.6;

/** Clamp a number into [0,1]; non-finite -> 0 (defensive — Req 7.6). */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** A weight contributes only when finite and positive; otherwise treated as 0. */
function sanitizeWeight(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 0;
  return w;
}

/** Human-readable label for a document type, used in feedback messages. */
function docTypeLabel(docType: EssayDocType): string {
  switch (docType) {
    case 'SOP':
      return 'SOP';
    case 'MOTIVATION':
      return 'thư động lực';
    case 'CV':
      return 'CV';
    default:
      return 'bài viết';
  }
}

/**
 * Deterministic, actionable feedback for a single low-scoring criterion. The
 * message references the document type so guidance is concrete (Req 7.3).
 */
function feedbackFor(key: RubricCriterion['key'], docType: EssayDocType): string {
  const label = docTypeLabel(docType);
  switch (key) {
    case 'structure':
      return `Cải thiện cấu trúc ${label}: đảm bảo mở bài – thân bài – kết luận mạch lạc.`;
    case 'relevance':
      return `Tăng độ liên quan của ${label} với chương trình mục tiêu (mục tiêu học tập, lý do chọn trường/ngành).`;
    case 'lengthCompliance':
      return `Điều chỉnh độ dài ${label} để tuân thủ giới hạn yêu cầu.`;
    case 'requiredSections':
      return `Bổ sung các phần bắt buộc còn thiếu trong ${label}.`;
    default:
      return `Cải thiện ${label} theo tiêu chí rubric.`;
  }
}

/**
 * Review an essay against a weighted rubric.
 *
 * @param content the essay text (used only to ground feedback; scoring is rubric-driven)
 * @param docType the document kind (drives feedback wording — Req 7.3)
 * @param rubric  the weighted criteria; weights and the total weight may be 0
 * @returns an {@link EssayReview} whose `score` is always in [0,1] (Req 7.1, 7.6)
 *
 * Pure + deterministic (Req 7.2): identical `content` + `rubric` (+ `docType`)
 * always produce the identical `score` and `feedback`.
 */
export function reviewEssay(
  content: string,
  docType: EssayDocType,
  rubric: readonly RubricCriterion[],
): EssayReview {
  let weightSum = 0;
  let weightedScoreSum = 0;

  for (const criterion of rubric) {
    const weight = sanitizeWeight(criterion.weight);
    const score = clamp01(criterion.score);
    weightSum += weight;
    weightedScoreSum += weight * score;
  }

  // Req 7.4: total weight 0 -> default 0.0, continue (no division, no hard-fail).
  // Otherwise a true weighted average, clamped defensively to [0,1] (Req 7.6).
  const score = weightSum === 0 ? 0.0 : clamp01(weightedScoreSum / weightSum);

  // Deterministic feedback from low-scoring criteria, in rubric order, deduped
  // by dimension so the same key is not reported twice (Req 7.2, 7.3).
  const feedback: string[] = [];
  const seen = new Set<RubricCriterion['key']>();
  for (const criterion of rubric) {
    if (seen.has(criterion.key)) continue;
    if (clamp01(criterion.score) <= LOW_SCORE_THRESHOLD) {
      seen.add(criterion.key);
      feedback.push(feedbackFor(criterion.key, docType));
    }
  }

  if (feedback.length === 0) {
    const lengthNote = content.trim().length === 0 ? ' (lưu ý: nội dung trống)' : '';
    feedback.push(`Bài viết đạt yêu cầu rubric trên mọi tiêu chí được chấm${lengthNote}.`);
  }

  return { score, feedback };
}
