/**
 * Typed wrappers for the study-abroad enhancements: Document OCR & verification,
 * scholarship/financial matching, and behavior-based follow-up nurturing.
 */
import { api } from '../lib/apiClient';
import type {
  DocumentExtraction,
  FollowUpListResult,
  FollowUpTask,
  ScholarshipSuggestionsResult,
} from '../lib/types';

// ---- Document OCR & verification -------------------------------------------

export interface SubmitDocInput {
  candidateId: string;
  checklistItemId?: string;
  docType: string;
  rawText?: string;
  imageBase64?: string;
  mimeType?: string;
  requirement?: {
    minScore?: number;
    minGpa?: number;
    minAmountVndM?: number;
    asOf?: string;
  };
}

export function submitDocExtraction(input: SubmitDocInput): Promise<DocumentExtraction> {
  return api.post<DocumentExtraction>('/api/v1/doc-extractions', input);
}

export function listDocExtractions(candidateId: string): Promise<{ items: DocumentExtraction[] }> {
  return api.get<{ items: DocumentExtraction[] }>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/doc-extractions`,
  );
}

// ---- Scholarship / financial matching --------------------------------------

export interface FinanceInput {
  budgetPerYearVndM?: number;
  gpa?: number;
  ielts?: number;
  limit?: number;
}

export function getScholarshipSuggestions(
  candidateId: string,
  finance: FinanceInput,
): Promise<ScholarshipSuggestionsResult> {
  return api.get<ScholarshipSuggestionsResult>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/scholarship-suggestions`,
    { ...finance },
  );
}

// ---- Behavior-based follow-up ----------------------------------------------

export function listFollowUps(status?: string, page = 1, limit = 50): Promise<FollowUpListResult> {
  return api.get<FollowUpListResult>('/api/v1/follow-ups', { status, page, limit });
}

export function scanFollowUps(): Promise<{ scanned: number; queued: number }> {
  return api.post<{ scanned: number; queued: number }>('/api/v1/follow-ups/scan');
}

export function sendDueFollowUps(): Promise<{ sent: number; failed: number }> {
  return api.post<{ sent: number; failed: number }>('/api/v1/follow-ups/send-due');
}

export function cancelFollowUp(id: string): Promise<FollowUpTask> {
  return api.post<FollowUpTask>(`/api/v1/follow-ups/${encodeURIComponent(id)}/cancel`);
}
