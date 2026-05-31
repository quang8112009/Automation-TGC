/**
 * Typed wrappers for the AI recruitment-consultant agent + knowledge base
 * (customer: Thanh Giang Conincon). The consult/suggest/draft endpoints never
 * surface a 502 "AI not configured": when no Gemini key is set the backend
 * returns deterministic, knowledge-grounded results flagged `aiGenerated: false`.
 * Callers should render those as valid knowledge-based answers, not failures.
 */
import { api } from '../lib/apiClient';
import type {
  AiConsultResult,
  AiOutreachResult,
  KnowledgeEntry,
  SuggestJobOrdersResult,
} from '../lib/types';

// ---- AI consult / suggest / draft ------------------------------------------

export function aiConsult(question: string, candidateId?: string): Promise<AiConsultResult> {
  return api.post<AiConsultResult>('/api/v1/ai/consult', { question, candidateId });
}

export function aiSuggestJobOrders(candidateId: string): Promise<SuggestJobOrdersResult> {
  return api.post<SuggestJobOrdersResult>('/api/v1/ai/suggest-job-orders', { candidateId });
}

export function aiDraftOutreach(
  candidateId: string,
  jobOrderId: string,
): Promise<AiOutreachResult> {
  return api.post<AiOutreachResult>('/api/v1/ai/draft-outreach', {
    candidateId,
    jobOrderId,
  });
}

// ---- Knowledge base --------------------------------------------------------

export function listKnowledge(
  category?: string,
  market?: string,
): Promise<{ entries: KnowledgeEntry[] }> {
  return api.get<{ entries: KnowledgeEntry[] }>('/api/v1/knowledge', { category, market });
}

export interface KnowledgeInput {
  category?: string;
  title?: string;
  content?: string;
  tags?: string[];
  market?: string | null;
  active?: boolean;
}

export function createKnowledge(input: KnowledgeInput): Promise<KnowledgeEntry> {
  return api.post<KnowledgeEntry>('/api/v1/knowledge', input);
}

export function updateKnowledge(id: string, input: KnowledgeInput): Promise<KnowledgeEntry> {
  return api.put<KnowledgeEntry>(`/api/v1/knowledge/${encodeURIComponent(id)}`, input);
}
