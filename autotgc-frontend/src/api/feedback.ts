import { api } from '../lib/apiClient';
import type { InsightDetail, InsightListResult } from '../lib/types';

export function runAnalyze(): Promise<unknown> {
  return api.post<unknown>('/api/feedback/analyze');
}

export function listInsights(page = 1, limit = 20): Promise<InsightListResult> {
  return api.get<InsightListResult>('/api/feedback/insights', { page, limit });
}

export function getInsight(id: string): Promise<InsightDetail> {
  return api.get<InsightDetail>(`/api/feedback/insights/${encodeURIComponent(id)}`);
}

export function applyInsight(id: string): Promise<unknown> {
  return api.post<unknown>(`/api/feedback/insights/${encodeURIComponent(id)}/apply`);
}

export function rejectInsight(id: string, reason: string): Promise<unknown> {
  return api.post<unknown>(`/api/feedback/insights/${encodeURIComponent(id)}/reject`, { reason });
}

export function modifyInsight(
  id: string,
  modifiedChange: Record<string, unknown>,
): Promise<unknown> {
  return api.post<unknown>(`/api/feedback/insights/${encodeURIComponent(id)}/modify`, {
    modifiedChange,
  });
}

// ---- Analytics (collect/score) ----------------------------------------------

export function runCollect(): Promise<unknown> {
  return api.post<unknown>('/api/analytics/collect');
}

export function runScore(postId: string): Promise<unknown> {
  return api.post<unknown>('/api/analytics/score', { postId });
}
