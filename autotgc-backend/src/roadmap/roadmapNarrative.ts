/**
 * Roadmap_Narrative — Gemini-optional natural-language narration of a
 * `RoadmapEstimate` for the study-abroad "Lộ trình Du học → Nghề nghiệp →
 * Định cư (ROI)" capability (study-abroad-ai-advisor-suite — Nhóm 5).
 *
 * Mirrors the `RecruitmentConsultantAgent` / `EssayWriter` Gemini-optional
 * discipline exactly:
 *  - When a `ContentGenerator` (Gemini) seam IS configured, `narrate` builds a
 *    deterministic, secret-free grounding prompt from the estimate + knowledge
 *    notes and asks Gemini to phrase the narrative → `aiGenerated = true`
 *    (Req 17.1).
 *  - On ANY Gemini failure, blank output, or a missing seam it returns a
 *    DETERMINISTIC narrative built purely from the `RoadmapEstimate`
 *    (`aiGenerated = false`) and NEVER throws a 502 (Req 17.2).
 *  - Neither the prompt nor the narrative ever embeds a secret value
 *    (Req 17.4): both are assembled ONLY from the estimate numbers and the
 *    supplied `KnowledgeNote`s.
 *  - The narrative NEVER asserts or guarantees an immigration / PR outcome
 *    beyond the grounded knowledge — PR/residency guidance is surfaced verbatim
 *    from the grounded `prPathwayNotes` with an explicit "không cam kết" caveat
 *    (Req 17.5).
 *
 * `buildDeterministicNarrative` and `buildNarrativePrompt` are pure and exported
 * so they can be unit-tested directly without touching the Gemini seam.
 */
import type { ContentGenerator } from '../strategy/personaService';
import type { KnowledgeNote, RoadmapEstimate } from './types';
import { enforceAiGeneratedFlag } from '../infra/aiOptional';
import { assertNoSecrets } from '../infra/secretGuard';

/** Result of a {@link RoadmapNarrative.narrate} call. */
export interface NarrateResult {
  /** The narrative text. */
  text: string;
  /** `true` iff the text came from Gemini; `false` for the deterministic fallback. */
  aiGenerated: boolean;
}

/** Render a numeric-or-`INSUFFICIENT_DATA` metric as grounded Vietnamese text. */
function renderMetric(value: number | 'INSUFFICIENT_DATA', suffix: string): string {
  return value === 'INSUFFICIENT_DATA' ? 'Chưa đủ dữ liệu' : `${value}${suffix}`;
}

/**
 * Build a DETERMINISTIC, grounded narrative from a {@link RoadmapEstimate}
 * (Req 17.2). Pure + deterministic: the output depends ONLY on the estimate, it
 * performs no I/O, and it never embeds a secret value (Req 17.4). Financial
 * metrics that are `'INSUFFICIENT_DATA'` are surfaced as "Chưa đủ dữ liệu"
 * rather than a fabricated number. Career / PR guidance is rendered verbatim
 * from the estimate's grounded notes; the PR section carries an explicit
 * non-commitment caveat so the narrative never guarantees an immigration
 * outcome (Req 17.5).
 */
export function buildDeterministicNarrative(estimate: RoadmapEstimate): string {
  const sections: string[] = [];

  sections.push('## Lộ trình Du học → Nghề nghiệp → Định cư');
  sections.push(
    'Đây là bản tường thuật được tổng hợp tự động từ ước lượng lộ trình. ' +
      'Các con số mang tính tham khảo, dựa trên dữ liệu chương trình hiện có.',
  );

  // --- Chi phí & ROI (numeric-safe rendering) ---
  sections.push('');
  sections.push('## Chi phí ước tính');
  sections.push(
    `- Chi phí ròng mỗi năm: ${renderMetric(estimate.netCostPerYearVndM, ' triệu VND')}.`,
  );
  sections.push(
    `- Tổng chi phí ước tính: ${renderMetric(estimate.totalCostVndM, ' triệu VND')}.`,
  );
  sections.push(
    `- Tỷ lệ hoàn vốn (ROI ước tính): ${renderMetric(estimate.roi, '')}.`,
  );

  // --- Định hướng nghề nghiệp (grounded notes only) ---
  sections.push('');
  sections.push('## Định hướng nghề nghiệp sau tốt nghiệp');
  if (estimate.careerNotes.length > 0) {
    for (const note of estimate.careerNotes) {
      sections.push(`- ${note}`);
    }
  } else {
    sections.push(
      '- Chưa có dữ liệu nền về định hướng nghề nghiệp cho lộ trình này. ' +
        'Vui lòng trao đổi thêm với chuyên viên tư vấn.',
    );
  }

  // --- Lộ trình định cư (grounded notes only; NO guaranteed outcome) ---
  sections.push('');
  sections.push('## Lộ trình định cư (tham khảo)');
  if (estimate.prPathwayNotes.length > 0) {
    for (const note of estimate.prPathwayNotes) {
      sections.push(`- ${note}`);
    }
  } else {
    sections.push(
      '- Chưa có dữ liệu nền về lộ trình định cư cho lộ trình này.',
    );
  }
  sections.push(
    '> Lưu ý: thông tin định cư chỉ mang tính tham khảo theo dữ liệu nền hiện có ' +
      'và KHÔNG cam kết bất kỳ kết quả định cư/thường trú nào.',
  );

  return sections.join('\n');
}

/**
 * Build a DETERMINISTIC grounding prompt for Gemini from the same estimate +
 * knowledge notes. Contains ONLY the estimate numbers and the supplied
 * knowledge — it NEVER embeds secrets (Req 17.4) — and explicitly instructs the
 * model to ground PR/residency guidance in the notes WITHOUT guaranteeing an
 * immigration outcome (Req 17.5). Pure + deterministic (fixed segment order).
 */
export function buildNarrativePrompt(
  estimate: RoadmapEstimate,
  knowledge: readonly KnowledgeNote[],
): string {
  const segments: string[] = [];

  segments.push(
    '[Role] Bạn là chuyên viên tư vấn du học. Hãy viết một bản tường thuật ngắn gọn, ' +
      'bằng tiếng Việt, về lộ trình Du học → Nghề nghiệp → Định cư dựa trên ước lượng dưới đây. ' +
      'Chỉ dùng số liệu được cung cấp; không bịa thêm con số.',
  );

  segments.push(
    '[Estimate] Ước lượng tài chính (triệu VND, trừ ROI):\n' +
      `- Chi phí ròng/năm: ${renderMetric(estimate.netCostPerYearVndM, '')}\n` +
      `- Tổng chi phí: ${renderMetric(estimate.totalCostVndM, '')}\n` +
      `- ROI: ${renderMetric(estimate.roi, '')}`,
  );

  if (estimate.careerNotes.length > 0) {
    segments.push(
      '[CareerNotes] Dữ liệu nền về nghề nghiệp:\n' +
        estimate.careerNotes.map((n) => `- ${n}`).join('\n'),
    );
  }

  if (estimate.prPathwayNotes.length > 0) {
    segments.push(
      '[PRNotes] Dữ liệu nền về lộ trình định cư:\n' +
        estimate.prPathwayNotes.map((n) => `- ${n}`).join('\n'),
    );
  }

  if (knowledge.length > 0) {
    segments.push(
      '[RetrievedKnowledge] Dữ liệu nền bổ sung:\n' +
        knowledge.map((k, i) => `(${i + 1}) ${k.title}: ${k.content}`).join('\n'),
    );
  }

  segments.push(
    '[Instructions] Viết bản tường thuật có cấu trúc rõ ràng: chi phí/ROI, định hướng nghề nghiệp, ' +
      'lộ trình định cư. Khi nói về định cư/thường trú, CHỈ bám sát dữ liệu nền và KHÔNG cam kết ' +
      'hay bảo đảm bất kỳ kết quả định cư nào. Nếu một chỉ số là "Chưa đủ dữ liệu", hãy nói rõ điều đó.',
  );

  const prompt = segments.join('\n\n');
  assertNoSecrets(prompt, 'ROADMAP_PROMPT_SECRET_DETECTED');
  return prompt;
}

/**
 * Gemini-optional roadmap narrator. The Gemini seam is injected (optional) so
 * the feature is fully usable without an API key.
 */
export class RoadmapNarrative {
  constructor(
    /** Gemini seam (GeminiClient satisfies this structurally). Optional. */
    private readonly gemini?: ContentGenerator,
  ) {}

  /**
   * Narrate a {@link RoadmapEstimate}.
   *
   * - When Gemini IS configured, builds a grounded, secret-free prompt
   *   (Req 17.4) and calls `generateContent`; on success the phrased text is
   *   returned with `aiGenerated = true` (Req 17.1).
   * - On ANY Gemini error, blank output, or a missing seam, it returns
   *   `buildDeterministicNarrative(estimate)` with `aiGenerated = false` and
   *   NEVER throws a 502 (Req 17.2).
   * - The narrative never guarantees an immigration / PR outcome beyond the
   *   grounded knowledge (Req 17.5) — both the prompt and the deterministic
   *   fallback enforce this.
   */
  async narrate(
    estimate: RoadmapEstimate,
    knowledge: readonly KnowledgeNote[],
  ): Promise<NarrateResult> {
    if (this.gemini) {
      const prompt = buildNarrativePrompt(estimate, knowledge);
      try {
        const text = await this.gemini.generateContent(prompt);
        if (text && text.trim().length > 0) {
          return enforceAiGeneratedFlag({ text: text.trim(), aiGenerated: true }, 'AI');
        }
      } catch {
        // Fall through to the deterministic narrative (covers AI_NOT_CONFIGURED
        // and any transient Gemini failure — Req 17.2).
      }
    }

    return enforceAiGeneratedFlag(
      { text: buildDeterministicNarrative(estimate), aiGenerated: false },
      'FALLBACK',
    );
  }
}
