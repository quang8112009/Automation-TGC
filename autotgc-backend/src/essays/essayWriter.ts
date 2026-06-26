/**
 * Essay_Writer — Gemini-optional draft generation for SOP / motivation letter /
 * CV documents (study-abroad-ai-advisor-suite — Nhóm 2, Req 6.1–6.7).
 *
 * Mirrors the `RecruitmentConsultantAgent` Gemini-optional pattern: a
 * `ContentGenerator` seam (GeminiClient satisfies it structurally) is OPTIONAL;
 * when it is absent or fails the writer falls back to a deterministic, grounded
 * structured draft and NEVER throws a 502 (Req 6.2, 6.3). The structured draft
 * is built purely from the candidate + program context and never embeds any
 * secret value (API keys, credentials) in the prompt or output (Req 6.4).
 *
 * Generation mode is explicit (Req 6.7):
 *  - 'STRUCTURED' → always `buildStructuredDraft`, `aiGenerated = false`,
 *    regardless of whether Gemini is configured.
 *  - 'AI'         → use Gemini when configured (`aiGenerated = true`); on ANY
 *    error or a missing seam, fall back to the structured draft
 *    (`aiGenerated = false`).
 *
 * `buildStructuredDraft` and the prompt builder are pure and exported so they
 * can be tested directly without touching the Gemini seam.
 */
import type { ContentGenerator } from '../strategy/personaService';
import type { EssayContext, EssayDocType } from './types';
import { enforceAiGeneratedFlag } from '../infra/aiOptional';
import { assertNoSecrets } from '../infra/secretGuard';

/** Explicit generation mode chosen by the caller (Req 6.7). */
export type EssayGenMode = 'AI' | 'STRUCTURED';

/** Result of an {@link EssayWriter.write} call. */
export interface EssayWriteResult {
  /** The draft text. */
  content: string;
  /** `true` iff the text came from Gemini; `false` for the structured fallback. */
  aiGenerated: boolean;
}

/** Trim and return a non-empty string, or `undefined` when blank/missing. */
function clean(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Human-readable document label used in headings/prompts. */
function docTypeLabel(docType: EssayDocType): string {
  switch (docType) {
    case 'SOP':
      return 'Statement of Purpose (SOP)';
    case 'MOTIVATION':
      return 'Thư động lực';
    case 'CV':
      return 'CV';
    default:
      return 'Bài viết';
  }
}

/**
 * Build a deterministic, grounded structured draft from the candidate + program
 * context (Req 6.3). For `CV` this is a structured CV outline; for `SOP` /
 * `MOTIVATION` it is structured prose sections. The output depends ONLY on the
 * provided context (pure + deterministic) and never embeds any secret value
 * (Req 6.4).
 */
export function buildStructuredDraft(ctx: EssayContext, docType: EssayDocType): string {
  const name = clean(ctx.candidateName) ?? 'Ứng viên';
  const education = clean(ctx.educationLevel);
  const program = clean(ctx.programName);
  const country = clean(ctx.programCountry);
  const field = clean(ctx.fieldOfStudy);

  // Grounded program target phrase reused across sections.
  const programTarget =
    program && country
      ? `${program} (${country})`
      : program
        ? program
        : country
          ? `chương trình tại ${country}`
          : 'chương trình mục tiêu';

  if (docType === 'CV') {
    // Structured CV outline (section headers + grounded bullet placeholders).
    const lines: string[] = [];
    lines.push(`CV — ${name}`);
    lines.push('');
    lines.push('## Thông tin cá nhân');
    lines.push(`- Họ và tên: ${name}`);
    lines.push('- Liên hệ: (điện thoại / email)');
    lines.push('');
    lines.push('## Mục tiêu');
    lines.push(
      field
        ? `- Theo đuổi ${field} tại ${programTarget}.`
        : `- Theo học ${programTarget}.`,
    );
    lines.push('');
    lines.push('## Học vấn');
    lines.push(education ? `- ${education}` : '- (Trình độ học vấn — bổ sung chi tiết)');
    lines.push('');
    lines.push('## Kinh nghiệm & Hoạt động');
    lines.push('- (Liệt kê kinh nghiệm/dự án liên quan)');
    lines.push('');
    lines.push('## Kỹ năng');
    lines.push('- (Ngôn ngữ, kỹ năng chuyên môn liên quan tới ngành)');
    lines.push('');
    lines.push('## Thành tích');
    lines.push('- (Giải thưởng, chứng chỉ nếu có)');
    return lines.join('\n');
  }

  // SOP / MOTIVATION → structured prose sections.
  const label = docTypeLabel(docType);
  const sections: string[] = [];
  sections.push(`${label} — ${name}`);
  sections.push('');
  sections.push('## Mở bài');
  sections.push(
    `Tôi là ${name}${education ? `, hiện có nền tảng ${education}` : ''}. ` +
      `Tôi viết bài này để bày tỏ nguyện vọng theo học ${programTarget}` +
      `${field ? ` trong lĩnh vực ${field}` : ''}.`,
  );
  sections.push('');
  sections.push('## Động lực và mục tiêu');
  sections.push(
    `Lý do tôi chọn ${programTarget}${field ? ` và lĩnh vực ${field}` : ''} ` +
      'xuất phát từ định hướng học tập và nghề nghiệp của bản thân. ' +
      '(Trình bày cụ thể mục tiêu ngắn hạn và dài hạn.)',
  );
  sections.push('');
  sections.push('## Nền tảng và sự phù hợp');
  sections.push(
    education
      ? `Với nền tảng ${education}, tôi đã chuẩn bị các kiến thức và kỹ năng nền tảng. ` +
          '(Liên hệ kinh nghiệm/thành tích với yêu cầu của chương trình.)'
      : '(Trình bày nền tảng học vấn, kinh nghiệm và sự phù hợp với chương trình.)',
  );
  sections.push('');
  sections.push('## Lý do chọn chương trình');
  sections.push(
    `Tôi tin rằng ${programTarget} phù hợp với mục tiêu của tôi vì ` +
      '(nêu điểm mạnh của chương trình/trường liên quan tới định hướng cá nhân).',
  );
  sections.push('');
  sections.push('## Kết luận');
  sections.push(
    `Tôi mong muốn được trao cơ hội theo học ${programTarget} và cam kết nỗ lực ` +
      'để đạt kết quả tốt nhất. Trân trọng cảm ơn.',
  );
  return sections.join('\n');
}

/**
 * Build a deterministic grounding prompt for Gemini from the same context as the
 * structured draft. Contains only candidate/program context — it NEVER embeds
 * secrets (Req 6.4) and asks for Vietnamese output grounded in the supplied facts.
 */
export function buildEssayPrompt(ctx: EssayContext, docType: EssayDocType): string {
  const label = docTypeLabel(docType);
  const facts: string[] = [];
  const name = clean(ctx.candidateName);
  const education = clean(ctx.educationLevel);
  const program = clean(ctx.programName);
  const country = clean(ctx.programCountry);
  const field = clean(ctx.fieldOfStudy);
  if (name) facts.push(`tên ứng viên: ${name}`);
  if (education) facts.push(`trình độ học vấn: ${education}`);
  if (program) facts.push(`chương trình mục tiêu: ${program}`);
  if (country) facts.push(`quốc gia: ${country}`);
  if (field) facts.push(`lĩnh vực: ${field}`);

  const prompt = [
    `Bạn là chuyên viên tư vấn du học. Hãy soạn một bản nháp ${label} bằng tiếng Việt.`,
    facts.length > 0
      ? `Chỉ dựa trên các thông tin sau, không bịa thêm số liệu: ${facts.join('; ')}.`
      : 'Thông tin hồ sơ còn hạn chế; hãy viết khung bản nháp tổng quát, không bịa số liệu.',
    docType === 'CV'
      ? 'Trình bày dưới dạng CV có cấu trúc rõ ràng theo từng mục.'
      : 'Trình bày dưới dạng văn xuôi có cấu trúc: mở bài, động lực/mục tiêu, nền tảng, lý do chọn chương trình, kết luận.',
  ].join('\n');
  assertNoSecrets(prompt, 'ESSAY_PROMPT_SECRET_DETECTED');
  return prompt;
}

/**
 * Gemini-optional essay writer. The Gemini seam is injected (optional) so the
 * feature is fully usable without an API key.
 */
export class EssayWriter {
  constructor(
    /** Gemini seam (GeminiClient satisfies this structurally). Optional. */
    private readonly gemini?: ContentGenerator,
  ) {}

  /**
   * Produce a draft for `docType` in the requested `mode`.
   *
   * - `mode === 'STRUCTURED'` → always the deterministic structured draft with
   *   `aiGenerated = false`, regardless of the Gemini seam (Req 6.7).
   * - `mode === 'AI'` → when Gemini is configured, build a grounded prompt (no
   *   secrets — Req 6.4) and call `generateContent`; on success `aiGenerated =
   *   true`. On ANY error, blank output, or a missing seam, fall back to
   *   `buildStructuredDraft` with `aiGenerated = false` and NEVER throw 502
   *   (Req 6.2, 6.3).
   */
  async write(
    ctx: EssayContext,
    docType: EssayDocType,
    mode: EssayGenMode,
  ): Promise<EssayWriteResult> {
    if (mode === 'AI' && this.gemini) {
      const prompt = buildEssayPrompt(ctx, docType);
      try {
        const text = await this.gemini.generateContent(prompt);
        if (text && text.trim().length > 0) {
          return enforceAiGeneratedFlag({ content: text.trim(), aiGenerated: true }, 'AI');
        }
      } catch {
        // Fall through to the deterministic structured draft (covers
        // AI_NOT_CONFIGURED and any transient Gemini failure — Req 6.2, 6.3).
      }
    }

    return enforceAiGeneratedFlag(
      { content: buildStructuredDraft(ctx, docType), aiGenerated: false },
      'FALLBACK',
    );
  }
}
