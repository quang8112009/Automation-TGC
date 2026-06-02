/**
 * Work_Assistant — "Trợ lý Công việc TGC (TGC Work Assistant)".
 *
 * A thin internal-employee facade over the existing `RecruitmentConsultantAgent`.
 * The underlying agent already implements exactly the grounding behavior we need:
 * it retrieves the most-relevant ACTIVE `KnowledgeEntry` rows via
 * `KnowledgeService.search` (pure `rankRows` ranking — descending relevance with a
 * stable title tie-break), assembles a deterministic, ordered system prompt that
 * embeds ONLY public company information (never secrets), and — only when a Gemini
 * key is configured at runtime — calls Gemini to phrase the answer. When Gemini is
 * absent or fails it returns a deterministic, knowledge-grounded fallback answer
 * (flagged `aiGenerated: false`) instead of throwing a 502.
 *
 * This facade does NOT replace or remove `RecruitmentConsultantAgent` (its routes
 * `/api/v1/ai/consult|suggest-job-orders|draft-outreach` keep working). It adds:
 *   1. an employee-oriented `ask({ question, role, userId })` API returning an
 *      `AssistantAnswer` ({ answer, sources, aiGenerated }), and
 *   2. role-based business-data scoping (`scopeBusinessData`) so SALES only ever
 *      sees rows assigned to them while ADMIN sees everything.
 *
 * Purity: `scopeBusinessData` is a pure, framework-free function exported for
 * direct property testing. Only `ask` touches the (injected) Gemini seam and the
 * KnowledgeService. Empty-question validation (400) is enforced at the route layer
 * (task 5.5); `ask` itself is defensive and never throws for a blank question.
 */
import type { KnowledgeEntry } from '@prisma/client';
import type { ContentGenerator } from '../../strategy/personaService';
import type { KnowledgeService } from '../knowledge/knowledgeService';
import { RecruitmentConsultantAgent } from './consultantAgent';

/** The role of the employee asking the assistant. */
export type AssistantRole = 'ADMIN' | 'SALES';

/** An authenticated employee question to the Work_Assistant. */
export interface AssistantQuery {
  question: string;
  role: AssistantRole;
  userId: string;
}

/** Result returned by `WorkAssistant.ask`. */
export interface AssistantAnswer {
  /** Vietnamese answer text (Gemini-phrased or deterministic grounded fallback). */
  answer: string;
  /** The ACTIVE KnowledgeEntry rows used to ground the answer, in ranked order. */
  sources: KnowledgeEntry[];
  /** true iff the answer text came from Gemini; false for the grounded fallback. */
  aiGenerated: boolean;
}

/** Role + identity used to scope business data. */
export interface BusinessScope {
  role: AssistantRole;
  userId: string;
}

/**
 * Scope business rows (candidates / leads) by the asker's role. (Req 7.1–7.3)
 *
 * - ADMIN: returns ALL rows, unfiltered and order-preserving.
 * - SALES: returns ONLY rows assigned to the asker, i.e. `assignedTo === userId`.
 *   Rows assigned to someone else AND unassigned rows (`assignedTo` null/undefined)
 *   are dropped, so no out-of-scope record can leak into an answer.
 *
 * Pure and deterministic: depends only on its inputs and preserves relative order.
 */
export function scopeBusinessData<T extends { assignedTo?: string | null }>(
  rows: readonly T[],
  scope: BusinessScope,
): T[] {
  if (scope.role === 'ADMIN') {
    return [...rows];
  }
  return rows.filter((row) => row.assignedTo != null && row.assignedTo === scope.userId);
}

/**
 * WorkAssistant — facade that wraps `RecruitmentConsultantAgent` for internal
 * employee Q&A and adds role-based business-data scoping.
 */
export class WorkAssistant {
  private readonly agent: RecruitmentConsultantAgent;

  constructor(
    private readonly knowledge: KnowledgeService,
    /** Optional Gemini seam; when absent the assistant uses grounded fallbacks. */
    gemini?: ContentGenerator,
  ) {
    this.agent = new RecruitmentConsultantAgent(knowledge, gemini);
  }

  /**
   * Answer an employee's question, grounded on the ACTIVE Knowledge_Base.
   *
   * Behavior:
   *  - Normalizes the question (trim). A blank question yields an empty,
   *    knowledge-less fallback rather than throwing (the route layer rejects
   *    blank questions with 400 — Req 6.5).
   *  - Retrieves the most-relevant ACTIVE `KnowledgeEntry` rows via the existing
   *    `KnowledgeService.search` ranking (Req 6.1, 8.3).
   *  - With Gemini configured → grounded prompt → `aiGenerated = true` (Req 6.2);
   *    with Gemini absent or on ANY Gemini error → deterministic grounded answer
   *    → `aiGenerated = false`, never throwing a 502 (Req 6.3).
   *  - Always includes the grounding `sources` (Req 6.4) and answers in Vietnamese
   *    (Req 6.6). No secret values are ever embedded in the prompt or answer
   *    (Req 7.5) — guaranteed by the underlying agent's prompt builder.
   */
  async ask(query: AssistantQuery): Promise<AssistantAnswer> {
    const question = (query.question ?? '').trim();
    const result = await this.agent.consult(question);
    return {
      answer: result.answer,
      sources: result.sources,
      aiGenerated: result.aiGenerated,
    };
  }

  /**
   * Scope business rows by this query's role/identity. Convenience wrapper around
   * the pure `scopeBusinessData` so callers that already hold an `AssistantQuery`
   * (or a `BusinessScope`) can reuse the same role policy. (Req 7.1–7.3)
   */
  scopeBusinessData<T extends { assignedTo?: string | null }>(
    rows: readonly T[],
    scope: BusinessScope,
  ): T[] {
    return scopeBusinessData(rows, scope);
  }
}
