import { api, apiRequest } from '../lib/apiClient';
import type { DraftDetail, DraftListResult } from '../lib/types';

export interface GenerateInput {
  domainName: string;
  personaIds: string[];
  objective?: string;
}

export function generateDraft(input: GenerateInput): Promise<unknown> {
  return api.post<unknown>('/api/generation/generate', input);
}

export function listDrafts(page = 1, limit = 20): Promise<DraftListResult> {
  return api.get<DraftListResult>('/api/generation/drafts', { page, limit });
}

export function getDraft(id: string): Promise<DraftDetail> {
  return api.get<DraftDetail>(`/api/generation/drafts/${encodeURIComponent(id)}`);
}

export interface EditDraftInput {
  title?: string;
  body?: string;
  ctas?: string[];
}

export function editDraft(id: string, input: EditDraftInput): Promise<DraftDetail> {
  return api.put<DraftDetail>(`/api/generation/drafts/${encodeURIComponent(id)}`, input);
}

/** Two-step delete: without confirm => returns { confirmationRequired }. */
export function requestDeleteDraft(id: string): Promise<{ confirmationRequired: true; id: string }> {
  return apiRequest(`/api/generation/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function confirmDeleteDraft(id: string): Promise<{ deleted: true; id: string }> {
  return apiRequest(`/api/generation/drafts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    query: { confirm: 'true' },
  });
}

export function getDraftReview(id: string): Promise<unknown> {
  return api.get<unknown>(`/api/generation/drafts/${encodeURIComponent(id)}/review`);
}

export function approveDraft(id: string): Promise<unknown> {
  return api.post<unknown>(`/api/generation/drafts/${encodeURIComponent(id)}/approve`);
}

export function rejectDraft(id: string, reason: string): Promise<unknown> {
  return api.post<unknown>(`/api/generation/drafts/${encodeURIComponent(id)}/reject`, { reason });
}

export interface AttachMediaInput {
  draftId: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export function attachMedia(input: AttachMediaInput): Promise<unknown> {
  return api.post<unknown>('/api/media', input);
}
