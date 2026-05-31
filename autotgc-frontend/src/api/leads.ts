import { api, apiDownload, apiRequest } from '../lib/apiClient';
import type { Lead, LeadDetail, LeadListResult, LeadStats } from '../lib/types';

export interface LeadFilters {
  source?: string;
  platform?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export function listLeads(filters: LeadFilters): Promise<LeadListResult> {
  return api.get<LeadListResult>('/api/leads', {
    source: filters.source,
    platform: filters.platform,
    status: filters.status,
    from: filters.from,
    to: filters.to,
    page: filters.page,
    limit: filters.limit,
  });
}

export function getLeadStats(
  groupBy: 'source' | 'platform' | 'date',
  from?: string,
  to?: string,
): Promise<LeadStats> {
  return api.get<LeadStats>('/api/leads/stats', { groupBy, from, to });
}

export function getLead(id: string): Promise<LeadDetail> {
  return api.get<LeadDetail>(`/api/leads/${encodeURIComponent(id)}`);
}

export interface CreateLeadInput {
  name?: string;
  phone?: string;
  email?: string;
  source?: string;
  platform?: string;
  contentPostId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  domainCategory?: string;
  contentTopic?: string;
}

export function createLead(input: CreateLeadInput): Promise<Lead> {
  return api.post<Lead>('/api/leads', input);
}

export interface UpdateLeadInput {
  status?: string;
  note?: string | null;
  assignedTo?: string | null;
}

export function updateLead(id: string, input: UpdateLeadInput): Promise<Lead> {
  return api.put<Lead>(`/api/leads/${encodeURIComponent(id)}`, input);
}

export function deleteLead(id: string): Promise<{ status: string }> {
  return api.del<{ status: string }>(`/api/leads/${encodeURIComponent(id)}`);
}

export function exportLeads(
  format: 'csv' | 'json',
  from?: string,
  to?: string,
): Promise<{ blob: Blob; filename: string }> {
  return apiDownload('/api/leads/export', { format, from, to });
}

// Re-export apiRequest for advanced callers if needed.
export { apiRequest };
