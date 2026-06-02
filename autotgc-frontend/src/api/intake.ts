/**
 * Typed wrappers for the omni-channel chatbot intake endpoints (Facebook
 * Messenger + Zalo OA + website widget). The webhooks themselves are called by
 * the platforms; these wrappers cover the authenticated consultant views and
 * the simulate endpoint used to test the dossier flow from the UI.
 */
import { api } from '../lib/apiClient';
import type { IntakeConversation, IntakeListResult, IntakeSimulateResult } from '../lib/types';

export function listConversations(
  status?: string,
  page = 1,
  limit = 20,
): Promise<IntakeListResult> {
  return api.get<IntakeListResult>('/api/v1/intake/conversations', { status, page, limit });
}

export function getConversation(id: string): Promise<IntakeConversation> {
  return api.get<IntakeConversation>(`/api/v1/intake/conversations/${encodeURIComponent(id)}`);
}

/** Drive the same flow as a real channel message — used to demo/test the bot. */
export function simulateIntake(
  externalUserId: string,
  text: string,
  displayName?: string,
): Promise<IntakeSimulateResult> {
  return api.post<IntakeSimulateResult>('/api/v1/intake/simulate', {
    externalUserId,
    text,
    displayName,
  });
}
