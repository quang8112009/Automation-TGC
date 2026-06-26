/**
 * RecruitmentConsultantAgent — an AI recruitment consultant for Thanh Giang
 * Conincon (Vietnamese labor-export / XKLĐ), grounded in a curated knowledge base.
 *
 * HONESTY / GROUNDING NOTE (important):
 * This agent is NOT a fine-tuned or trained LLM. "Huấn luyện AI" here means
 * RETRIEVAL GROUNDING: it pulls the most relevant `KnowledgeEntry` records via
 * `KnowledgeService.search`, assembles a deterministic, ordered system prompt,
 * and — only when a Gemini API key is configured at runtime — calls Gemini to
 * phrase the answer. When Gemini is NOT configured (no key) or fails, the agent
 * returns a deterministic, knowledge-based fallback answer (flagged
 * `aiGenerated: false`) instead of throwing. The feature is therefore fully
 * usable without any API key, and we never claim AI output we did not produce.
 *
 * Purity: `buildSystemPrompt`, `suggestJobOrders`, the fallback assemblers and
 * the outreach prompt builder are pure and exported for testing. Only `consult`
 * and `draftOutreach` may touch the (injected) Gemini seam and KnowledgeService.
 */
import type { KnowledgeEntry, JobOrder } from '@prisma/client';
import type { ContentGenerator } from '../../strategy/personaService';
import type { KnowledgeService } from '../knowledge/knowledgeService';
import { COMPANY_IDENTITY } from '../knowledge/knowledgeBase';
import { enforceAiGeneratedFlag } from '../../infra/aiOptional';
import { assertNoSecrets } from '../../infra/secretGuard';

/** Candidate context the consultant can use to tailor answers and matches. */
export interface CandidateContext {
  fullName?: string | null;
  desiredMarket?: string | null; // JAPAN | GERMANY | KOREA | TAIWAN | DOMESTIC | OTHER
  desiredIndustry?: string | null; // free text, e.g. "Điều dưỡng"
  desiredVisaType?: string | null; // TOKUTEI | ENGINEER | TRAINEE | ...
  gender?: string | null; // MALE | FEMALE | ""
  japaneseLevel?: string | null; // NONE | N5 | N4 | N3 | N2 | N1
}

/** Result of a consult() call. */
export interface ConsultResult {
  answer: string;
  sources: KnowledgeEntry[];
  /** true iff the answer text came from Gemini; false for the grounded fallback. */
  aiGenerated: boolean;
}

/** A scored job-order suggestion with a short, human-readable reason. */
export interface JobOrderSuggestion {
  jobOrder: JobOrder;
  score: number;
  reasons: string[];
}

/** Result of a draftOutreach() call. */
export interface OutreachResult {
  message: string;
  aiGenerated: boolean;
}

/** Number of knowledge entries retrieved to ground a consult answer. */
export const CONSULT_RETRIEVAL_LIMIT = 5;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

function clean(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Pure system-prompt builder. Emits segments in a STRICT, fixed order:
 *   1. [CompanyRole]        — company identity + consultant role (ALWAYS first)
 *   2. [CandidateContext]   — desired market / visa / industry (only if provided)
 *   3. [RetrievedKnowledge] — grounding entries (ALWAYS present; says "none" if empty)
 *   4. [AnswerInstructions] — how to answer (ALWAYS last)
 *
 * Deterministic: depends only on its inputs. Contains only public company info;
 * it never embeds API keys or other secret-like values.
 */
export function buildSystemPrompt(
  question: string,
  knowledge: readonly KnowledgeEntry[],
  candidate?: CandidateContext,
): string {
  const segments: string[] = [];

  // 1. Company role (always first).
  segments.push(
    `[CompanyRole] Bạn là chuyên viên tư vấn xuất khẩu lao động của ${COMPANY_IDENTITY.name} ` +
      `(thành lập ${COMPANY_IDENTITY.founded}, trụ sở ${COMPANY_IDENTITY.hq}, ${COMPANY_IDENTITY.branchesNote}). ` +
      `Tư vấn trung thực, thân thiện, đúng thông tin; không hứa hẹn hay bịa chi phí/điều kiện. ` +
      `Khi thông tin tùy đơn hàng, hãy mời ứng viên liên hệ hotline ${COMPANY_IDENTITY.hotline.join(' / ')}.`,
  );

  // 2. Candidate context (only when something is provided).
  if (candidate) {
    const facts: string[] = [];
    const market = clean(candidate.desiredMarket);
    const visa = clean(candidate.desiredVisaType);
    const industry = clean(candidate.desiredIndustry);
    const gender = clean(candidate.gender);
    const jp = clean(candidate.japaneseLevel);
    if (market) facts.push(`thị trường mong muốn: ${market}`);
    if (visa) facts.push(`diện visa quan tâm: ${visa}`);
    if (industry) facts.push(`ngành nghề quan tâm: ${industry}`);
    if (gender) facts.push(`giới tính: ${gender}`);
    if (jp) facts.push(`trình độ tiếng: ${jp}`);
    if (facts.length > 0) {
      segments.push(`[CandidateContext] Thông tin ứng viên — ${facts.join('; ')}.`);
    }
  }

  // 3. Retrieved knowledge (always present so the order is fixed).
  if (knowledge.length > 0) {
    const lines = knowledge.map((k, i) => `(${i + 1}) [${k.category}] ${k.title}: ${k.content}`);
    segments.push(`[RetrievedKnowledge] Dữ liệu nền để trả lời:\n${lines.join('\n')}`);
  } else {
    segments.push(
      '[RetrievedKnowledge] Không tìm thấy dữ liệu nền phù hợp. ' +
        'Hãy trả lời thận trọng và hướng ứng viên liên hệ tư vấn trực tiếp.',
    );
  }

  // 4. Answer instructions (always last).
  segments.push(
    '[AnswerInstructions] Trả lời bằng tiếng Việt, ngắn gọn, bám sát dữ liệu nền ở trên. ' +
      'Không bịa số liệu; nếu chi tiết tùy đơn hàng thì nói rõ và mời liên hệ tư vấn. ' +
      `Câu hỏi của ứng viên: "${question.trim()}"`,
  );

  const prompt = segments.join('\n\n');
  assertNoSecrets(prompt, 'CONSULTANT_PROMPT_SECRET_DETECTED');
  return prompt;
}

/**
 * Pure grounded-fallback answer assembled from retrieved knowledge. Used when
 * Gemini is not configured or fails. Clearly a knowledge-based summary, not a
 * pretend "AI" response.
 */
export function buildGroundedAnswer(
  question: string,
  knowledge: readonly KnowledgeEntry[],
): string {
  const header =
    `Cảm ơn bạn đã quan tâm tới ${COMPANY_IDENTITY.name}. Dựa trên thông tin của công ty, ` +
    'đây là phần giải đáp cho câu hỏi của bạn:';

  if (knowledge.length === 0) {
    return [
      header,
      '',
      'Hiện chưa có sẵn nội dung phù hợp với câu hỏi này trong cơ sở dữ liệu. ' +
        `Bạn vui lòng liên hệ hotline ${COMPANY_IDENTITY.hotline.join(' / ')} ` +
        `hoặc email ${COMPANY_IDENTITY.email} để được tư vấn trực tiếp.`,
    ].join('\n');
  }

  const points = knowledge.map((k) => `• ${k.title}: ${k.content}`);
  const footer =
    `Để biết điều kiện và chi phí chính xác theo trường hợp của bạn, vui lòng liên hệ hotline ` +
    `${COMPANY_IDENTITY.hotline.join(' / ')} hoặc email ${COMPANY_IDENTITY.email}.`;

  return [header, '', ...points, '', footer].join('\n');
}

/** Normalize for comparison: lowercase, trimmed. */
function norm(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Japanese level ordering for "candidate meets requirement" comparisons. */
const JP_LEVELS = ['none', 'n5', 'n4', 'n3', 'n2', 'n1'];
function jpRank(level: string | null | undefined): number {
  const idx = JP_LEVELS.indexOf(norm(level));
  return idx < 0 ? 0 : idx;
}

/**
 * Pure ranking of OPEN job orders against a candidate's preferences. Returns a
 * deterministic list (descending score, then job-order code for a stable
 * tie-break). Only OPEN orders are considered. No external calls.
 *
 * Scoring:
 *  - market match:   +5
 *  - visa match:     +4
 *  - industry match: +3 (substring either direction)
 *  - gender ok:      +1 (order ANY, or matches candidate gender)
 *  - japanese ok:    +1 (candidate level >= a level mentioned in description; best-effort)
 */
export function suggestJobOrders(
  candidate: CandidateContext,
  openJobOrders: readonly JobOrder[],
  limit = 10,
): JobOrderSuggestion[] {
  const suggestions: JobOrderSuggestion[] = [];

  for (const jo of openJobOrders) {
    if (jo.status !== 'OPEN') continue;

    const reasons: string[] = [];
    let score = 0;

    if (clean(candidate.desiredMarket) && norm(candidate.desiredMarket) === norm(jo.market)) {
      score += 5;
      reasons.push(`Đúng thị trường mong muốn (${jo.market})`);
    }
    if (clean(candidate.desiredVisaType) && norm(candidate.desiredVisaType) === norm(jo.visaType)) {
      score += 4;
      reasons.push(`Đúng diện visa (${jo.visaType})`);
    }
    const ci = norm(candidate.desiredIndustry);
    const ji = norm(jo.industry);
    if (ci.length > 0 && ji.length > 0 && (ji.includes(ci) || ci.includes(ji))) {
      score += 3;
      reasons.push(`Phù hợp ngành nghề (${jo.industry})`);
    }
    const cg = norm(candidate.gender);
    const jg = norm(jo.gender);
    if (cg.length > 0) {
      if (jg === '' || jg === 'any' || jg === cg) {
        score += 1;
        reasons.push('Phù hợp yêu cầu giới tính');
      } else {
        reasons.push('Lưu ý: đơn yêu cầu giới tính khác');
      }
    }
    if (jpRank(candidate.japaneseLevel) > 0) {
      // Best-effort: if the description mentions an N-level the candidate meets.
      const desc = norm(jo.description) + ' ' + norm(jo.title);
      const mentioned = JP_LEVELS.find((lvl) => lvl !== 'none' && desc.includes(lvl));
      if (mentioned && jpRank(candidate.japaneseLevel) >= jpRank(mentioned)) {
        score += 1;
        reasons.push(`Đáp ứng trình độ tiếng (${candidate.japaneseLevel})`);
      }
    }

    if (score > 0) {
      suggestions.push({ jobOrder: jo, score, reasons });
    }
  }

  suggestions.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.jobOrder.code.localeCompare(b.jobOrder.code);
  });

  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return suggestions.slice(0, n);
}

/** Pure prompt builder for an outreach message (grounded in the job order). */
export function buildOutreachPrompt(
  candidate: CandidateContext,
  jobOrder: JobOrder,
  knowledge: readonly KnowledgeEntry[],
): string {
  const name = clean(candidate.fullName) ?? 'bạn';
  const segments: string[] = [];

  segments.push(
    `[CompanyRole] Bạn là chuyên viên tuyển dụng của ${COMPANY_IDENTITY.name}. ` +
      'Soạn tin nhắn tiếp cận ứng viên qua Zalo/Facebook/điện thoại, văn phong thân thiện, lịch sự, tiếng Việt.',
  );
  segments.push(
    `[JobOrder] Đơn hàng ${jobOrder.code} - ${jobOrder.title}; ngành ${jobOrder.industry || 'N/A'}; ` +
      `thị trường ${jobOrder.market}; diện ${jobOrder.visaType}; nơi làm việc ${jobOrder.workLocation || 'N/A'}; ` +
      `mức lương ${jobOrder.salaryText || 'thỏa thuận'}; số lượng ${jobOrder.quantity}; ` +
      `yêu cầu giới tính ${jobOrder.gender}.`,
  );
  segments.push(`[Candidate] Ứng viên: ${name}.`);
  if (knowledge.length > 0) {
    segments.push(
      '[Knowledge] Bối cảnh tham khảo:\n' +
        knowledge.map((k) => `- ${k.title}: ${k.content}`).join('\n'),
    );
  }
  segments.push(
    '[Instructions] Viết một tin nhắn ngắn (3-5 câu): chào hỏi, giới thiệu đơn hàng phù hợp, ' +
      `mời trao đổi thêm và để lại hotline ${COMPANY_IDENTITY.hotline.join(' / ')}. Không bịa chi phí/điều kiện.`,
  );

  const prompt = segments.join('\n\n');
  assertNoSecrets(prompt, 'CONSULTANT_PROMPT_SECRET_DETECTED');
  return prompt;
}

/** Pure grounded-fallback outreach message template (no AI needed). */
export function buildOutreachFallback(candidate: CandidateContext, jobOrder: JobOrder): string {
  const name = clean(candidate.fullName) ?? 'bạn';
  const salary = jobOrder.salaryText ? ` mức lương tham khảo ${jobOrder.salaryText},` : '';
  const location = jobOrder.workLocation ? ` tại ${jobOrder.workLocation}` : '';
  return [
    `Chào ${name}, mình là chuyên viên tuyển dụng của ${COMPANY_IDENTITY.name}.`,
    `Bên mình đang có đơn hàng ${jobOrder.code} - ${jobOrder.title} ` +
      `(ngành ${jobOrder.industry || 'đa ngành'}, thị trường ${jobOrder.market}, diện ${jobOrder.visaType})${location},${salary} ` +
      'mình thấy khá phù hợp với nguyện vọng của bạn.',
    `Bạn quan tâm thì nhắn lại giúp mình nhé, hoặc liên hệ hotline ${COMPANY_IDENTITY.hotline.join(' / ')} ` +
      'để được tư vấn chi tiết và miễn phí. Cảm ơn bạn!',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class RecruitmentConsultantAgent {
  constructor(
    private readonly knowledge: KnowledgeService,
    /** Gemini seam (GeminiClient satisfies this structurally). Optional. */
    private readonly gemini?: ContentGenerator,
  ) {}

  /**
   * Answer a candidate's question. Retrieves grounding knowledge, builds the
   * prompt, and calls Gemini when configured. On ANY Gemini failure (including
   * 502 AI_NOT_CONFIGURED) it returns a deterministic grounded fallback answer
   * built from the same retrieved entries — it never throws for missing AI.
   */
  async consult(question: string, candidate?: CandidateContext): Promise<ConsultResult> {
    const q = (question ?? '').trim();
    // Graceful degradation (R5.8): a Knowledge_Base retrieval failure must not
    // surface to the end user — degrade to no grounding and continue.
    let sources: KnowledgeEntry[] = [];
    if (q.length > 0) {
      try {
        sources = await this.knowledge.search(q, CONSULT_RETRIEVAL_LIMIT);
      } catch {
        sources = [];
      }
    }

    if (this.gemini) {
      const prompt = buildSystemPrompt(q, sources, candidate);
      try {
        const answer = await this.gemini.generateContent(prompt);
        if (answer && answer.trim().length > 0) {
          return enforceAiGeneratedFlag({ answer: answer.trim(), sources, aiGenerated: true }, 'AI');
        }
      } catch {
        // Fall through to the grounded fallback (covers AI_NOT_CONFIGURED too).
      }
    }

    return enforceAiGeneratedFlag(
      { answer: buildGroundedAnswer(q, sources), sources, aiGenerated: false },
      'FALLBACK',
    );
  }

  /** Pure pass-through to the ranking helper (no external calls). */
  suggestJobOrders(
    candidate: CandidateContext,
    openJobOrders: readonly JobOrder[],
    limit = 10,
  ): JobOrderSuggestion[] {
    return suggestJobOrders(candidate, openJobOrders, limit);
  }

  /**
   * Draft a Vietnamese outreach message grounded in the job order + knowledge.
   * Gemini-optional: falls back to a deterministic template when unconfigured
   * or on failure.
   */
  async draftOutreach(candidate: CandidateContext, jobOrder: JobOrder): Promise<OutreachResult> {
    const query = [clean(jobOrder.industry), clean(jobOrder.market), clean(jobOrder.visaType)]
      .filter((x): x is string => x !== undefined)
      .join(' ');
    // Graceful degradation (R5.8): tolerate a Knowledge_Base retrieval failure.
    let sources: KnowledgeEntry[] = [];
    if (query.length > 0) {
      try {
        sources = await this.knowledge.search(query, 3);
      } catch {
        sources = [];
      }
    }

    if (this.gemini) {
      const prompt = buildOutreachPrompt(candidate, jobOrder, sources);
      try {
        const message = await this.gemini.generateContent(prompt);
        if (message && message.trim().length > 0) {
          return enforceAiGeneratedFlag({ message: message.trim(), aiGenerated: true }, 'AI');
        }
      } catch {
        // Fall through to the deterministic template.
      }
    }

    return enforceAiGeneratedFlag(
      { message: buildOutreachFallback(candidate, jobOrder), aiGenerated: false },
      'FALLBACK',
    );
  }
}
