/**
 * Content_Editor — pure quality rubric for the Multi-Agent Team (proposal 3.4).
 *
 * After the Copywriter (GenerationService / ContentGenerationAgent) drafts
 * content, the Editor scores it against a deterministic rubric BEFORE it reaches
 * the human review_gate. The rubric is pure and framework-free (no Prisma /
 * Fastify / Gemini) so it is deterministic and property-testable, mirroring
 * `analytics/scoring.ts` and `content/stateMachine.ts`.
 *
 * Verdict policy: start at 100, deduct per issue by severity; the draft PASSes
 * iff `score >= PASS_THRESHOLD` AND there is no `error`-severity issue. Anything
 * else is REVISE (it should loop back to the Copywriter / self-correction).
 */

/** Stable issue codes the editor can raise (sorted, deterministic output). */
export type EditorIssueCode =
  | 'MISSING_CTA'
  | 'TITLE_TOO_SHORT'
  | 'TITLE_TOO_LONG'
  | 'BODY_TOO_SHORT'
  | 'NO_OBJECTIVE_SIGNAL'
  | 'TONE_MISMATCH';

export type EditorSeverity = 'info' | 'warn' | 'error';

export interface EditorIssue {
  code: EditorIssueCode;
  message: string;
  severity: EditorSeverity;
}

export type EditorVerdict = 'PASS' | 'REVISE';

export interface EditorReview {
  /** Quality score in [0, 100]. */
  score: number;
  verdict: EditorVerdict;
  /** Issues found, in a stable (code-sorted) order. */
  issues: EditorIssue[];
  /** Short, human-readable summary (deterministic; may be enriched by AI later). */
  summary: string;
}

export interface EditorInput {
  title: string;
  body: string;
  ctas: readonly string[];
  objective?: string;
  toneOfVoice?: string;
}

/** Score at or above which a draft may PASS (when no error-severity issue). */
export const PASS_THRESHOLD = 70;

/** Per-severity point deduction applied to the starting score of 100. */
export const SEVERITY_PENALTY: Readonly<Record<EditorSeverity, number>> = {
  info: 5,
  warn: 12,
  error: 30,
};

/** Title length window (characters, trimmed). */
export const TITLE_MIN = 8;
export const TITLE_MAX = 120;

/** Minimum acceptable body length (characters, trimmed). */
export const BODY_MIN = 40;

/** Objective -> signal keywords (vi + en) used by the weak NO_OBJECTIVE_SIGNAL check. */
const OBJECTIVE_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  Lead: ['liên hệ', 'đăng ký', 'tư vấn', 'hotline', 'để lại', 'contact', 'register', 'sign up'],
  View: ['xem', 'tìm hiểu', 'khám phá', 'chi tiết', 'read', 'watch', 'learn more', 'discover'],
  Follow: ['theo dõi', 'follow', 'like', 'fanpage', 'kênh', 'subscribe', 'cập nhật'],
};

/** True when a value is a non-blank string. */
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Count the non-blank CTAs in the list. */
export function countCtas(ctas: readonly string[]): number {
  return ctas.filter((c) => isNonBlank(c)).length;
}

/** Clamp a number into [0, 100]; non-finite -> 0. */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * True when the body shows at least one keyword aligned with the objective.
 * Unknown/blank objective -> treated as satisfied (we only warn when we have a
 * known objective and find no aligned signal at all).
 */
export function hasObjectiveSignal(body: string, objective?: string): boolean {
  if (!isNonBlank(objective)) return true;
  const signals = OBJECTIVE_SIGNALS[objective.trim()];
  if (!signals || signals.length === 0) return true;
  const haystack = body.toLowerCase();
  return signals.some((s) => haystack.includes(s.toLowerCase()));
}

/**
 * Pure rubric. Returns the deduction-based score, the sorted issue list, the
 * PASS/REVISE verdict, and a deterministic one-line summary.
 */
export function reviewDraft(input: EditorInput): EditorReview {
  const title = (input.title ?? '').trim();
  const body = (input.body ?? '').trim();
  const issues: EditorIssue[] = [];

  if (countCtas(input.ctas ?? []) === 0) {
    issues.push({
      code: 'MISSING_CTA',
      message: 'Nội dung phải có ít nhất một CTA (call-to-action).',
      severity: 'error',
    });
  }

  if (title.length < TITLE_MIN) {
    issues.push({
      code: 'TITLE_TOO_SHORT',
      message: `Tiêu đề quá ngắn (tối thiểu ${TITLE_MIN} ký tự).`,
      severity: 'warn',
    });
  } else if (title.length > TITLE_MAX) {
    issues.push({
      code: 'TITLE_TOO_LONG',
      message: `Tiêu đề quá dài (tối đa ${TITLE_MAX} ký tự).`,
      severity: 'warn',
    });
  }

  if (body.length < BODY_MIN) {
    issues.push({
      code: 'BODY_TOO_SHORT',
      message: `Nội dung quá ngắn (tối thiểu ${BODY_MIN} ký tự).`,
      severity: 'warn',
    });
  }

  if (!hasObjectiveSignal(body, input.objective)) {
    issues.push({
      code: 'NO_OBJECTIVE_SIGNAL',
      message: `Nội dung chưa thể hiện mục tiêu "${(input.objective ?? '').trim()}".`,
      severity: 'info',
    });
  }

  if (isNonBlank(input.toneOfVoice) && body.length > 0) {
    // Weak, deterministic heuristic: a "friendly/thân thiện" tone should not be
    // ALL-CAPS shouting. Only flagged as info — never blocks a PASS by itself.
    const tone = input.toneOfVoice.toLowerCase();
    const wantsFriendly = tone.includes('friendly') || tone.includes('thân thiện');
    const letters = body.replace(/[^a-zA-ZÀ-ỹ]/g, '');
    const upper = body.replace(/[^A-ZÀ-Ỹ]/g, '');
    const shouting = letters.length >= 12 && upper.length / letters.length > 0.6;
    if (wantsFriendly && shouting) {
      issues.push({
        code: 'TONE_MISMATCH',
        message: 'Giọng văn yêu cầu thân thiện nhưng nội dung đang VIẾT HOA như đang hô hào.',
        severity: 'info',
      });
    }
  }

  // Sort issues by code for a stable, deterministic output.
  issues.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const penalty = issues.reduce((sum, i) => sum + SEVERITY_PENALTY[i.severity], 0);
  const score = clampScore(100 - penalty);
  const hasError = issues.some((i) => i.severity === 'error');
  const verdict: EditorVerdict = score >= PASS_THRESHOLD && !hasError ? 'PASS' : 'REVISE';

  const summary =
    verdict === 'PASS'
      ? `Đạt yêu cầu biên tập (điểm ${score}/100).`
      : `Cần chỉnh sửa (điểm ${score}/100): ${
          issues.length > 0 ? issues.map((i) => i.code).join(', ') : 'không đạt ngưỡng chất lượng'
        }.`;

  return { score, verdict, issues, summary };
}
