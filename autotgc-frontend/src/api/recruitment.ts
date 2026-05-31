/**
 * Typed wrappers for the recruitment-CRM endpoints (XKLĐ — Thanh Giang
 * Conincon): job orders (đơn hàng tuyển dụng) and candidates (ứng viên).
 * Built on the shared `api` helper; all paths use the /api/v1 gateway prefix
 * and inherit Bearer auth + the { error: { code, message } } envelope handling.
 */
import { api } from '../lib/apiClient';
import type {
  Candidate,
  CandidateDetail,
  CandidateListResult,
  CandidateStats,
  JobOrder,
  JobOrderListResult,
} from '../lib/types';

// ---- Job orders ------------------------------------------------------------

export interface JobOrderFilters {
  market?: string;
  visaType?: string;
  industry?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export function listJobOrders(filters: JobOrderFilters): Promise<JobOrderListResult> {
  return api.get<JobOrderListResult>('/api/v1/job-orders', {
    market: filters.market,
    visaType: filters.visaType,
    industry: filters.industry,
    status: filters.status,
    page: filters.page,
    limit: filters.limit,
  });
}

export function getJobOrder(id: string): Promise<JobOrder> {
  return api.get<JobOrder>(`/api/v1/job-orders/${encodeURIComponent(id)}`);
}

export interface CreateJobOrderInput {
  code?: string;
  title?: string;
  industry?: string;
  visaType?: string;
  market?: string;
  workLocation?: string;
  salaryText?: string;
  quantity?: number;
  gender?: string;
  nationalityReq?: string;
  status?: string;
  deadline?: string | null;
  description?: string;
}

export function createJobOrder(input: CreateJobOrderInput): Promise<JobOrder> {
  return api.post<JobOrder>('/api/v1/job-orders', input);
}

export type UpdateJobOrderInput = CreateJobOrderInput;

export function updateJobOrder(id: string, input: UpdateJobOrderInput): Promise<JobOrder> {
  return api.put<JobOrder>(`/api/v1/job-orders/${encodeURIComponent(id)}`, input);
}

export function closeJobOrder(id: string): Promise<JobOrder> {
  return api.post<JobOrder>(`/api/v1/job-orders/${encodeURIComponent(id)}/close`);
}

// ---- Candidates ------------------------------------------------------------

export interface CandidateFilters {
  stage?: string;
  desiredMarket?: string;
  assignedTo?: string;
  branchId?: string;
  page?: number;
  limit?: number;
}

export function listCandidates(filters: CandidateFilters): Promise<CandidateListResult> {
  return api.get<CandidateListResult>('/api/v1/candidates', {
    stage: filters.stage,
    desiredMarket: filters.desiredMarket,
    assignedTo: filters.assignedTo,
    branchId: filters.branchId,
    page: filters.page,
    limit: filters.limit,
  });
}

export function getCandidate(id: string): Promise<CandidateDetail> {
  return api.get<CandidateDetail>(`/api/v1/candidates/${encodeURIComponent(id)}`);
}

export interface CreateCandidateInput {
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  gender?: string;
  hometown?: string;
  education?: string;
  currentJob?: string;
  desiredMarket?: string | null;
  desiredIndustry?: string;
  desiredVisaType?: string | null;
  japaneseLevel?: string;
  otherLanguage?: string;
  assignedTo?: string | null;
  note?: string | null;
  source?: string;
}

export function createCandidate(input: CreateCandidateInput): Promise<Candidate> {
  return api.post<Candidate>('/api/v1/candidates', input);
}

export interface UpdateCandidateInput {
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  gender?: string;
  hometown?: string;
  education?: string;
  currentJob?: string;
  desiredMarket?: string | null;
  desiredIndustry?: string;
  desiredVisaType?: string | null;
  japaneseLevel?: string;
  otherLanguage?: string;
  assignedTo?: string | null;
  note?: string | null;
  /** Send {stage} to advance the candidate through the guarded state machine. */
  stage?: string;
}

export function updateCandidate(id: string, input: UpdateCandidateInput): Promise<Candidate> {
  return api.put<Candidate>(`/api/v1/candidates/${encodeURIComponent(id)}`, input);
}

export function matchCandidate(id: string, jobOrderId: string): Promise<Candidate> {
  return api.post<Candidate>(`/api/v1/candidates/${encodeURIComponent(id)}/match`, {
    jobOrderId,
  });
}

export interface PromoteFromLeadInput {
  fullName?: string;
  desiredMarket?: string | null;
  desiredIndustry?: string;
  desiredVisaType?: string | null;
  japaneseLevel?: string;
  otherLanguage?: string;
  hometown?: string;
  education?: string;
  currentJob?: string;
  gender?: string;
  assignedTo?: string | null;
  note?: string | null;
}

export function promoteLeadToCandidate(
  leadId: string,
  input: PromoteFromLeadInput = {},
): Promise<Candidate> {
  return api.post<Candidate>(
    `/api/v1/candidates/from-lead/${encodeURIComponent(leadId)}`,
    input,
  );
}

export function getCandidateStats(
  groupBy: 'stage' | 'desiredMarket' | 'branchId',
): Promise<CandidateStats> {
  return api.get<CandidateStats>('/api/v1/candidates/stats', { groupBy });
}

export function deleteCandidate(id: string): Promise<{ status: string }> {
  return api.del<{ status: string }>(`/api/v1/candidates/${encodeURIComponent(id)}`);
}
