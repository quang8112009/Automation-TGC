/**
 * Interview_Agent — Gemini-optional visa-interview question generation and
 * answer review, grounded in `visaCatalog` country knowledge and the curated
 * `KnowledgeService` knowledge base.
 *
 * HONESTY / GROUNDING NOTE (mirrors `RecruitmentConsultantAgent`):
 * This agent is NOT a fine-tuned model. "AI" here means RETRIEVAL GROUNDING: it
 * assembles a deterministic, secret-free prompt from `visaCatalog` + retrieved
 * `KnowledgeEntry` rows and — only when a Gemini seam is configured — asks
 * Gemini to phrase the output. It NEVER fabricates consulate policy or
 * interview outcomes; every fallback is a deterministic, grounded result
 * flagged `aiGenerated: false` (Req 11.1, 11.4).
 *
 * Gemini-optional discipline (mirrors `consultantAgent.consult`):
 *  - Questions: Gemini is used ONLY when configured AND the country has a
 *    `visaCatalog` template. For unknown countries we NEVER AI-generate; we use
 *    the deterministic `questionBankFor` set with `aiGenerated = false`
 *    (Req 10.3, 10.4). Any Gemini error falls back to the bank — never a 502.
 *  - A prompt is guarded for secret-like values BEFORE being sent; a detected
 *    secret fails the request with a 400 `ValidationError` rather than being
 *    silently stripped (Req 10.6). Prompts never embed secrets (Req 10.5).
 *
 * Purity: `buildQuestionPrompt`, `parseQuestions`, `buildAnswerFeedbackPrompt`,
 * `buildGroundedFeedback`, and `assertNoSecrets` are pure and exported for
 * testing. Only `generateQuestions` / `reviewAnswers` touch the (injected)
 * Gemini seam and `KnowledgeService`.
 */
import type { KnowledgeEntry } from '@prisma/client';
import type { ContentGenerator } from '../strategy/personaService';
import type { KnowledgeService } from '../recruitment/knowledge/knowledgeService';
import { hasCountryTemplate, normalizeCountry } from '../visa/visaCatalog';
import { questionBankFor } from './interviewQuestionBank';
import { assertNoSecrets as assertNoSecretsShared } from '../infra/secretGuard';
import { enforceAiGeneratedFlag } from '../infra/aiOptional';
import { isRecord, asString } from '../platforms/narrow';
import type { InterviewQuestion } from './types';

/** Number of knowledge entries retrieved to ground question/answer prompts. */
export const INTERVIEW_RETRIEVAL_LIMIT = 5;

/** A persisted interview session projected into a framework-free shape. */
export interface InterviewSessionView {
  id: string;
  candidateId: string;
  country: string;
  visaType: string;
  questions: InterviewQuestion[];
}

/** Result of {@link InterviewAgent.generateQuestions}. */
export interface GenerateQuestionsResult {
  questions: InterviewQuestion[];
  /** true iff the questions were phrased by Gemini; false for the bank fallback. */
  aiGenerated: boolean;
}

/** Result of {@link InterviewAgent.reviewAnswers}. */
export interface ReviewAnswersResult {
  /** Per-question-code grounded feedback. */
  feedback: Record<string, string>;
  /** true iff the feedback was phrased by Gemini; false for the grounded fallback. */
  aiGenerated: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Throw a 400 `ValidationError` if `text` contains a secret-like value. Thin
 * wrapper over the shared {@link assertNoSecretsShared} secret-guard, kept and
 * re-exported here for backward compatibility with existing imports and to
 * surface the interview-specific `INTERVIEW_PROMPT_SECRET_DETECTED` code.
 * Called on every prompt BEFORE it reaches Gemini so a secret is never
 * transmitted, and so the request fails loudly rather than the value being
 * silently dropped (Req 10.5, 10.6).
 */
export function assertNoSecrets(text: string): void {
  assertNoSecretsShared(text, 'INTERVIEW_PROMPT_SECRET_DETECTED');
}

/** Normalize for comparison/grounding: trimmed. */
function clean(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Pure prompt builder for AI question generation. Built ONLY from the country,
 * visa type, the deterministic question bank (as grounding anchors), and the
 * retrieved knowledge — it never embeds secrets (Req 10.5). Emits segments in a
 * STRICT, fixed order so the prompt is deterministic.
 */
export function buildQuestionPrompt(
  country: string,
  visaType: string,
  bank: readonly InterviewQuestion[],
  knowledge: readonly KnowledgeEntry[],
): string {
  const segments: string[] = [];

  segments.push(
    '[Role] Bạn là chuyên viên luyện phỏng vấn visa du học. Soạn bộ câu hỏi luyện tập ' +
      'thực tế, bám sát loại visa và quốc gia, bằng tiếng Việt (giữ thuật ngữ visa tiếng Anh ' +
      'khi cần). Không bịa chính sách lãnh sự hay kết quả phỏng vấn.',
  );
  segments.push(`[Target] Quốc gia: ${country}. Loại visa: ${visaType || 'không xác định'}.`);

  if (bank.length > 0) {
    const lines = bank.map((q, i) => `(${i + 1}) [${q.category}] ${q.prompt}`);
    segments.push(`[GroundingQuestions] Bộ câu hỏi nền (bám theo Visa_Catalog):\n${lines.join('\n')}`);
  }

  if (knowledge.length > 0) {
    const lines = knowledge.map((k, i) => `(${i + 1}) [${k.category}] ${k.title}: ${k.content}`);
    segments.push(`[RetrievedKnowledge] Dữ liệu nền bổ sung:\n${lines.join('\n')}`);
  }

  segments.push(
    '[Instructions] Trả về CHỈ một mảng JSON các câu hỏi, mỗi phần tử dạng ' +
      '{"code": string, "prompt": string, "category": string}. Không thêm văn bản ngoài JSON. ' +
      'Bám sát dữ liệu nền ở trên; không bịa yêu cầu lãnh sự.',
  );

  return segments.join('\n\n');
}

/**
 * Pure parser for the model's question JSON. Tolerant: strips Markdown code
 * fences, accepts an array or a `{ questions: [...] }` wrapper, and keeps only
 * well-formed `{ code, prompt, category }` entries (de-duplicated by code).
 * Returns an empty array when nothing parseable is found so callers fall back
 * to the deterministic bank rather than surfacing AI noise.
 */
export function parseQuestions(text: string): InterviewQuestion[] {
  const cleaned = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const rawList: unknown = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.questions)
      ? parsed.questions
      : [];

  const out: InterviewQuestion[] = [];
  const seen = new Set<string>();
  for (const item of rawList as unknown[]) {
    if (!isRecord(item)) continue;
    const code = asString(item.code);
    const prompt = asString(item.prompt);
    const category = asString(item.category);
    if (code === undefined || prompt === undefined) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, prompt, category: category ?? 'GENERAL' });
  }
  return out;
}

/** Strip Markdown code fences (```json ... ```), returning the inner text. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutFirst = trimmed.replace(/^```[a-zA-Z]*\s*/, '');
  const lastFence = withoutFirst.lastIndexOf('```');
  return (lastFence >= 0 ? withoutFirst.slice(0, lastFence) : withoutFirst).trim();
}

/**
 * Pure prompt builder for AI answer feedback. Built from the session's
 * questions, the candidate's answers, and retrieved knowledge — never embeds
 * secrets (Req 10.5). Deterministic segment order.
 */
export function buildAnswerFeedbackPrompt(
  session: InterviewSessionView,
  answers: Record<string, string>,
  knowledge: readonly KnowledgeEntry[],
): string {
  const segments: string[] = [];

  segments.push(
    '[Role] Bạn là chuyên viên luyện phỏng vấn visa du học. Đưa phản hồi mang tính xây dựng, ' +
      'bằng tiếng Việt, cho từng câu trả lời. Phản hồi phải bám sát dữ liệu nền; KHÔNG bịa ' +
      'chính sách lãnh sự hay dự đoán kết quả phỏng vấn (Req 11.4).',
  );
  segments.push(`[Target] Quốc gia: ${session.country}. Loại visa: ${session.visaType || 'không xác định'}.`);

  const qaLines = session.questions.map((q, i) => {
    const ans = clean(answers[q.code]) ?? '(chưa trả lời)';
    return `(${i + 1}) [${q.code}] Hỏi: ${q.prompt}\n    Đáp: ${ans}`;
  });
  if (qaLines.length > 0) {
    segments.push(`[QA] Cặp câu hỏi – câu trả lời:\n${qaLines.join('\n')}`);
  }

  if (knowledge.length > 0) {
    const lines = knowledge.map((k, i) => `(${i + 1}) [${k.category}] ${k.title}: ${k.content}`);
    segments.push(`[RetrievedKnowledge] Dữ liệu nền:\n${lines.join('\n')}`);
  }

  segments.push(
    '[Instructions] Trả về CHỈ một đối tượng JSON ánh xạ mã câu hỏi (code) → phản hồi (string). ' +
      'Không thêm văn bản ngoài JSON. Bám sát dữ liệu nền; không bịa yêu cầu lãnh sự.',
  );

  return segments.join('\n\n');
}

/**
 * Pure grounded fallback feedback for each question code. Used when Gemini is
 * not configured or fails. Deterministic and conservative — it acknowledges the
 * answer and points to the question topic WITHOUT inventing consulate policy or
 * predicting an outcome (Req 11.1, 11.4).
 */
export function buildGroundedFeedback(
  session: InterviewSessionView,
  answers: Record<string, string>,
): Record<string, string> {
  const feedback: Record<string, string> = {};
  for (const q of session.questions) {
    const ans = clean(answers[q.code]);
    if (ans === undefined) {
      feedback[q.code] =
        `Bạn chưa trả lời câu hỏi về ${q.category.toLowerCase()}. Hãy chuẩn bị một câu trả lời ` +
        'rõ ràng, trung thực, bám sát hồ sơ thực tế của bạn.';
    } else {
      feedback[q.code] =
        'Cảm ơn câu trả lời của bạn. Hãy đảm bảo trả lời cụ thể, nhất quán với hồ sơ và tài liệu ' +
        `đã chuẩn bị cho phần "${q.category.toLowerCase()}". Đây là phản hồi luyện tập, không phải ` +
        'dự đoán kết quả phỏng vấn.';
    }
  }
  return feedback;
}

/** Build the knowledge-retrieval query for a country/visa type. */
function retrievalQuery(country: string, visaType: string): string {
  return [clean(country), clean(visaType), 'visa interview phỏng vấn du học']
    .filter((x): x is string => x !== undefined)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class InterviewAgent {
  constructor(
    private readonly knowledge: KnowledgeService,
    /** Gemini seam (GeminiClient satisfies this structurally). Optional. */
    private readonly gemini?: ContentGenerator,
  ) {}

  /**
   * Generate a visa-interview question set for a country/visa type.
   *
   * - When Gemini IS configured AND the country has a `visaCatalog` template,
   *   builds a grounded, secret-free prompt and calls Gemini; on success the
   *   parsed questions are returned with `aiGenerated = true` (Req 10.2). On ANY
   *   Gemini error (or empty/unparseable output) it falls back to the
   *   deterministic `questionBankFor` set with `aiGenerated = false` — never a
   *   502 (Req 10.3).
   * - When Gemini is NOT configured OR the country has NO `visaCatalog`
   *   template, it returns the deterministic bank with `aiGenerated = false`
   *   and does NOT AI-generate for unknown countries (Req 10.3, 10.4).
   * - Before any prompt is sent it is guarded for secret-like values; a detected
   *   secret fails the request with a 400 rather than being stripped (Req 10.6).
   *   Prompts never embed secrets (Req 10.5).
   */
  async generateQuestions(country: string, visaType: string): Promise<GenerateQuestionsResult> {
    const normalizedCountry = normalizeCountry(country);
    const bank = questionBankFor(country, visaType);

    // Unknown country or no Gemini → deterministic bank, no AI generation.
    // (Req 10.3, 10.4)
    if (!this.gemini || !hasCountryTemplate(country)) {
      return enforceAiGeneratedFlag({ questions: bank, aiGenerated: false }, 'FALLBACK');
    }

    // Graceful degradation (R5.8): a Knowledge_Base retrieval failure must not
    // surface to the end user — degrade to no grounding and continue.
    let sources: KnowledgeEntry[] = [];
    try {
      sources = await this.knowledge.search(
        retrievalQuery(normalizedCountry, visaType),
        INTERVIEW_RETRIEVAL_LIMIT,
      );
    } catch {
      sources = [];
    }
    const prompt = buildQuestionPrompt(normalizedCountry, visaType, bank, sources);
    // Guard BEFORE sending: a secret-bearing prompt fails the request (Req 10.6).
    assertNoSecrets(prompt);

    try {
      const text = await this.gemini.generateContent(prompt);
      if (text && text.trim().length > 0) {
        const parsed = parseQuestions(text);
        if (parsed.length > 0) {
          return enforceAiGeneratedFlag({ questions: parsed, aiGenerated: true }, 'AI');
        }
      }
    } catch {
      // Fall through to the deterministic bank (covers AI_NOT_CONFIGURED too).
    }

    return enforceAiGeneratedFlag({ questions: bank, aiGenerated: false }, 'FALLBACK');
  }

  /**
   * Produce grounded per-answer feedback for a session.
   *
   * - Retrieves grounding knowledge and, when Gemini is configured, builds a
   *   secret-free prompt and asks Gemini to phrase the feedback
   *   (`aiGenerated = true`). On ANY failure / empty output it returns the
   *   deterministic grounded fallback (`aiGenerated = false`) — never a 502.
   * - Feedback NEVER fabricates consulate policy or interview outcomes; it is
   *   grounded in `Knowledge_Base` + `Visa_Catalog`-derived questions
   *   (Req 11.1, 11.4).
   * - The prompt is guarded for secrets before being sent (Req 10.5, 10.6).
   */
  async reviewAnswers(
    session: InterviewSessionView,
    answers: Record<string, string>,
  ): Promise<ReviewAnswersResult> {
    const fallback = buildGroundedFeedback(session, answers);

    if (this.gemini) {
      // Graceful degradation (R5.8): tolerate a Knowledge_Base retrieval failure.
      let sources: KnowledgeEntry[] = [];
      try {
        sources = await this.knowledge.search(
          retrievalQuery(session.country, session.visaType),
          INTERVIEW_RETRIEVAL_LIMIT,
        );
      } catch {
        sources = [];
      }
      const prompt = buildAnswerFeedbackPrompt(session, answers, sources);
      assertNoSecrets(prompt);
      try {
        const text = await this.gemini.generateContent(prompt);
        if (text && text.trim().length > 0) {
          const parsed = parseFeedback(text, session.questions);
          if (Object.keys(parsed).length > 0) {
            // Merge over the grounded fallback so every question still has feedback.
            return enforceAiGeneratedFlag(
              { feedback: { ...fallback, ...parsed }, aiGenerated: true },
              'AI',
            );
          }
        }
      } catch {
        // Fall through to the deterministic grounded feedback.
      }
    }

    return enforceAiGeneratedFlag({ feedback: fallback, aiGenerated: false }, 'FALLBACK');
  }
}

/**
 * Pure parser for the model's feedback JSON: strips fences, accepts a
 * `{ code: feedback }` map, and keeps only string values whose key matches a
 * known question code. Exported via the agent's private use; kept module-local.
 */
function parseFeedback(
  text: string,
  questions: readonly InterviewQuestion[],
): Record<string, string> {
  const cleaned = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const known = new Set(questions.map((q) => q.code));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!known.has(key)) continue;
    const text2 = asString(value);
    if (text2 !== undefined) out[key] = text2;
  }
  return out;
}
