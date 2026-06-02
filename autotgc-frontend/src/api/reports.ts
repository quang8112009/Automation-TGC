/**
 * Typed wrappers for the company-report endpoints (báo cáo công ty AI
 * TUẦN/THÁNG). Built on the shared `api` helper; all paths use the /api/v1
 * gateway prefix and inherit Bearer auth + the { error: { code, message } }
 * envelope handling. The markdown export uses `apiDownload` to capture the
 * Content-Disposition filename. Mirrors the api/leads.ts + api/recruitment.ts
 * conventions.
 */
import { api, apiDownload } from '../lib/apiClient';

export type ReportType = 'WEEKLY' | 'MONTHLY';

export type ReportStatus =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'ARCHIVED'
  | 'INSUFFICIENT_DATA';

/** A derived rate that may be unavailable when its denominator is empty. */
export type RateOrInsufficient = number | 'INSUFFICIENT_DATA';

/** Structured content of a company report (mirrors backend ReportContent). */
export interface ReportContent {
  executiveSummary: string;
  contentPerformance: {
    publishedCount: number;
    avgConversionRate: RateOrInsufficient;
    avgEngagementRate: RateOrInsufficient;
    avgCtaClickRate: RateOrInsufficient;
  };
  recruitmentFunnelByMarket: Array<{
    market: string;
    stageCounts: Record<string, number>;
  }>;
  leadsBySource: Array<{ source: string; count: number }>;
  highlights: string[];
  recommendations: string[];
}

/**
 * Read view of a persisted company report. Dates arrive as ISO strings over
 * JSON (the backend serializes Date → string).
 */
export interface CompanyReportView {
  id: string;
  reportType: ReportType;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  status: ReportStatus;
  content: ReportContent;
  aiGenerated: boolean;
  scopeUserId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportListResult {
  items: CompanyReportView[];
  total: number;
}

export interface ReportFilters {
  reportType?: ReportType;
  status?: ReportStatus;
}

/** GET /api/v1/reports — list reports (SALES only ever sees APPROVED). */
export function listReports(filters: ReportFilters = {}): Promise<ReportListResult> {
  return api.get<ReportListResult>('/api/v1/reports', {
    reportType: filters.reportType,
    status: filters.status,
  });
}

/** GET /api/v1/reports/:id — read a single report. */
export function getReport(id: string): Promise<CompanyReportView> {
  return api.get<CompanyReportView>(`/api/v1/reports/${encodeURIComponent(id)}`);
}

/** Explicit period payload for an on-demand generate (optional). */
export interface ReportPeriodInput {
  label: string;
  from: string;
  to: string;
}

export interface GenerateReportInput {
  reportType: ReportType;
  /** Omit to let the backend compute the just-ended period. */
  period?: ReportPeriodInput;
}

/** POST /api/v1/reports/generate — create a DRAFT report (ADMIN). */
export function generateReport(input: GenerateReportInput): Promise<CompanyReportView> {
  return api.post<CompanyReportView>('/api/v1/reports/generate', input);
}

/** PUT /api/v1/reports/:id — edit DRAFT/IN_REVIEW report content (ADMIN). */
export function updateReportContent(
  id: string,
  content: Partial<ReportContent>,
): Promise<CompanyReportView> {
  return api.put<CompanyReportView>(`/api/v1/reports/${encodeURIComponent(id)}`, content);
}

/** POST /api/v1/reports/:id/transition — drive the report state machine (ADMIN). */
export function transitionReport(
  id: string,
  target: ReportStatus,
): Promise<CompanyReportView> {
  return api.post<CompanyReportView>(
    `/api/v1/reports/${encodeURIComponent(id)}/transition`,
    { target },
  );
}

/** GET /api/v1/reports/:id/export — download the APPROVED report as markdown. */
export function exportReport(id: string): Promise<{ blob: Blob; filename: string }> {
  return apiDownload(`/api/v1/reports/${encodeURIComponent(id)}/export`);
}
