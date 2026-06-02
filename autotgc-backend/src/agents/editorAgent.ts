/**
 * EditorAgent (AI Execution Layer) — the "Editor" half of the Multi-Agent Team
 * (proposal 3.4). It runs AFTER the Copywriter (ContentGenerationAgent) and
 * BEFORE the human review_gate, scoring the draft against the deterministic
 * `reviewDraft` rubric and (optionally) enriching the summary via Gemini.
 *
 * Gemini-optional, mirroring PersonaService / RecruitmentConsultantAgent: when
 * no key is configured (or any Gemini call fails) the agent returns the
 * deterministic rubric result — it NEVER throws for missing AI. Domain/validation
 * errors surface as `{ ok: false, error }`; unknown/transient errors are rethrown
 * so the orchestrator's withRetry can retry (matches ContentGenerationAgent).
 */
import type { Agent, AgentContext, AgentResult } from './agent';
import { readString } from './agent';
import { AppError } from '../infra/errors';
import type { ContentGenerator } from '../strategy/personaService';
import { reviewDraft } from './contentEditor';
import type { EditorReview } from './contentEditor';

/** Variable keys this agent reads from the workflow context. */
export const EDITOR_INPUT_KEYS = ['title', 'body', 'ctas', 'objective', 'toneOfVoice'] as const;

/** Read an array-of-strings variable (filters non-strings); [] when absent. */
function readStringList(variables: Record<string, unknown>, key: string): string[] {
  const v = variables[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

export class EditorAgent implements Agent {
  public readonly name = 'review_content';

  constructor(
    /** Optional Gemini seam; when absent the editor uses the deterministic summary. */
    private readonly gemini?: ContentGenerator,
  ) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    try {
      const title = readString(ctx.variables, 'title') ?? '';
      const body = readString(ctx.variables, 'body') ?? '';
      const ctas = readStringList(ctx.variables, 'ctas');
      const objective = readString(ctx.variables, 'objective');
      const toneOfVoice = readString(ctx.variables, 'toneOfVoice');

      const review = reviewDraft({ title, body, ctas, objective, toneOfVoice });
      const summary = await this.enrichSummary(review, { title, body });

      return {
        ok: true,
        output: {
          editorScore: review.score,
          editorVerdict: review.verdict,
          editorIssues: review.issues,
          editorSummary: summary,
        },
      };
    } catch (err) {
      // Deterministic domain/validation errors -> structured failure.
      if (err instanceof AppError) {
        return { ok: false, error: `${err.code}: ${err.message}` };
      }
      // Re-throw unknown/transient errors so withRetry can retry them.
      throw err;
    }
  }

  /**
   * Optionally replace the deterministic summary with a Gemini critique. Any
   * failure (incl. AI_NOT_CONFIGURED) falls back to `review.summary` — never
   * throws for missing AI.
   */
  private async enrichSummary(
    review: EditorReview,
    draft: { title: string; body: string },
  ): Promise<string> {
    if (!this.gemini) return review.summary;
    try {
      const text = await this.gemini.generateContent(this.buildCritiquePrompt(review, draft));
      return text && text.trim().length > 0 ? text.trim() : review.summary;
    } catch {
      return review.summary;
    }
  }

  /** Deterministic grounding prompt for an editorial critique (no secrets). */
  private buildCritiquePrompt(
    review: EditorReview,
    draft: { title: string; body: string },
  ): string {
    const issueLines =
      review.issues.length > 0
        ? review.issues.map((i) => `- [${i.severity}] ${i.code}: ${i.message}`).join('\n')
        : '- (không có vấn đề tự động phát hiện)';
    return [
      'Bạn là biên tập viên nội dung marketing. Hãy nhận xét ngắn gọn bằng tiếng Việt ' +
        '(2-3 câu) cho bản nháp dưới đây, dựa trên điểm và danh sách vấn đề đã rà soát. ' +
        'Không bịa thông tin, tập trung vào cách cải thiện.',
      `Điểm rà soát: ${review.score}/100 (kết luận: ${review.verdict}).`,
      `Tiêu đề: ${draft.title}`,
      `Nội dung: ${draft.body}`,
      'Vấn đề tự động phát hiện:',
      issueLines,
    ].join('\n');
  }
}
