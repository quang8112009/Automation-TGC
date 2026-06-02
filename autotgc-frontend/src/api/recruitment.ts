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

// ---- Candidate document checklist ------------------------------------------
//
// Wrappers for the per-candidate document-checklist endpoints (Requirements
// 11.2, 13.1, 13.3, 13.4). The completion metric is divide-by-zero safe on the
// backend and surfaces the string 'INSUFFICIENT_DATA' instead of a ratio when
// there are no required items.

/** Submission status of a single checklist item (mirrors the backend enum). */
export type DocSubmissionStatus = 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

/** Origin of a checklist item: seeded from the market catalog, or added ad-hoc. */
export type DocSource = 'DEFAULT' | 'CUSTOM';

/** A single candidate document-checklist item (mirrors Prisma DocumentChecklistItem). */
export interface DocumentChecklistItem {
  id: string;
  candidateId: string;
  type: string;
  label: string;
  status: DocSubmissionStatus;
  required: boolean;
  source: DocSource;
  note: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/v1/candidates/:id/documents result: the items plus the completion
 * metric (a ratio in [0, 1], or 'INSUFFICIENT_DATA' when there are no required
 * items).
 */
export interface DocumentChecklistResult {
  items: DocumentChecklistItem[];
  completion: number | 'INSUFFICIENT_DATA';
}

export function listCandidateDocuments(candidateId: string): Promise<DocumentChecklistResult> {
  return api.get<DocumentChecklistResult>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/documents`,
  );
}

/** Seed the candidate's checklist from the market defaults (idempotent on the server). */
export function initCandidateDocuments(
  candidateId: string,
): Promise<{ items: DocumentChecklistItem[] }> {
  return api.post<{ items: DocumentChecklistItem[] }>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/documents/init`,
  );
}

export interface AddCustomDocumentInput {
  /** Display label; must be non-blank after trimming (server returns 400 otherwise). */
  label: string;
  /** Defaults to true on the server when omitted. */
  required?: boolean;
}

/** Add a candidate-specific CUSTOM checklist item. */
export function addCandidateDocument(
  candidateId: string,
  input: AddCustomDocumentInput,
): Promise<DocumentChecklistItem> {
  return api.post<DocumentChecklistItem>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/documents`,
    input,
  );
}

/** Update an item's submission status; the server accepts only the four enum values. */
export function updateDocumentStatus(
  itemId: string,
  status: DocSubmissionStatus,
): Promise<DocumentChecklistItem> {
  return api.put<DocumentChecklistItem>(
    `/api/v1/documents/${encodeURIComponent(itemId)}/status`,
    { status },
  );
}

// ---- Document type catalog (ADMIN) -----------------------------------------
//
// ADMIN-only wrappers for the per-market default document set
// (Requirement 12.4). The backend exposes GET/PUT /api/v1/document-catalog/:market.
// Updating the catalog does NOT change already-initialized candidate checklists.

/** A single default document-type definition for a market (mirrors backend DocTypeDef). */
export interface DocTypeDef {
  /** Stable, machine-readable document-type code (e.g. `PASSPORT`). */
  type: string;
  /** Human-facing Vietnamese label. */
  label: string;
  /** Whether the document is mandatory for the market. */
  required: boolean;
}

/** Result of GET/PUT /api/v1/document-catalog/:market. */
export interface DocumentCatalogResult {
  market: string;
  docs: DocTypeDef[];
}

/** GET /api/v1/document-catalog/:market — read the default doc set for a market. */
export function getDocumentCatalog(market: string): Promise<DocumentCatalogResult> {
  return api.get<DocumentCatalogResult>(
    `/api/v1/document-catalog/${encodeURIComponent(market)}`,
  );
}

/**
 * PUT /api/v1/document-catalog/:market — replace the default doc set for a market.
 * Does NOT touch existing candidates' checklists.
 */
export function updateDocumentCatalog(
  market: string,
  docs: DocTypeDef[],
): Promise<DocumentCatalogResult> {
  return api.put<DocumentCatalogResult>(
    `/api/v1/document-catalog/${encodeURIComponent(market)}`,
    { docs },
  );
}
