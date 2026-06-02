/**
 * Typed wrappers for the partners (đối tác đã hợp tác) + destination programs
 * (nơi đưa đi XKLĐ + điều kiện) endpoints, and the candidate destination-match
 * suggestion endpoint (đối chiếu DB & gợi ý cho tư vấn).
 */
import { api } from '../lib/apiClient';
import type {
  DestinationListResult,
  DestinationProgram,
  DestinationSuggestionsResult,
  PartnerListResult,
  PartnerOrg,
} from '../lib/types';

// ---- Partners --------------------------------------------------------------

export interface PartnerFilters {
  type?: string;
  country?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export function listPartners(filters: PartnerFilters = {}): Promise<PartnerListResult> {
  return api.get<PartnerListResult>('/api/v1/partners', { ...filters });
}

export interface PartnerInput {
  name?: string;
  type?: string;
  country?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  status?: string;
  notes?: string;
}

export function createPartner(input: PartnerInput): Promise<PartnerOrg> {
  return api.post<PartnerOrg>('/api/v1/partners', input);
}

export function updatePartner(id: string, input: PartnerInput): Promise<PartnerOrg> {
  return api.put<PartnerOrg>(`/api/v1/partners/${encodeURIComponent(id)}`, input);
}

export function setPartnerStatus(id: string, status: string): Promise<PartnerOrg> {
  return api.post<PartnerOrg>(`/api/v1/partners/${encodeURIComponent(id)}/status`, { status });
}

// ---- Destinations ----------------------------------------------------------

export interface DestinationFilters {
  country?: string;
  status?: string;
  activeOnly?: boolean;
  page?: number;
  limit?: number;
}

export function listDestinations(filters: DestinationFilters = {}): Promise<DestinationListResult> {
  return api.get<DestinationListResult>('/api/v1/destinations', { ...filters });
}

export interface DestinationInput {
  name?: string;
  country?: string;
  visaType?: string;
  partnerId?: string | null;
  minAge?: number | null;
  maxAge?: number | null;
  gender?: string;
  requiredLanguage?: string;
  minLanguageLevel?: string;
  budgetMinVndM?: number | null;
  budgetMaxVndM?: number | null;
  industries?: string[];
  conditions?: string[];
  status?: string;
  notes?: string;
  active?: boolean;
}

export function createDestination(input: DestinationInput): Promise<DestinationProgram> {
  return api.post<DestinationProgram>('/api/v1/destinations', input);
}

export function updateDestination(id: string, input: DestinationInput): Promise<DestinationProgram> {
  return api.put<DestinationProgram>(`/api/v1/destinations/${encodeURIComponent(id)}`, input);
}

export function setDestinationActive(id: string, active: boolean): Promise<DestinationProgram> {
  return api.post<DestinationProgram>(`/api/v1/destinations/${encodeURIComponent(id)}/active`, {
    active,
  });
}

// ---- Destination suggestions for a candidate -------------------------------

export function getDestinationSuggestions(
  candidateId: string,
  limit = 10,
): Promise<DestinationSuggestionsResult> {
  return api.get<DestinationSuggestionsResult>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/destination-suggestions`,
    { limit },
  );
}
