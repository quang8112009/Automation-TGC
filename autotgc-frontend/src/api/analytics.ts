/**
 * Typed wrappers for the candidate-level recruitment analytics endpoints
 * (XKLĐ — Thanh Giang). These measure the real funnel NEW → … → DEPARTED
 * ("đơn hàng → xuất cảnh"), not just raw leads. All paths use the /api/v1
 * gateway prefix and inherit Bearer auth + the { error:{code,message} } envelope.
 *
 * SALES callers are auto-scoped server-side to their assigned candidates.
 */
import { api } from '../lib/apiClient';

/** The recruitment pipeline stages (mirrors the backend CandidateStage enum). */
export type CandidateStage =
  | 'NEW'
  | 'CONSULTING'
  | 'PROFILE_COLLECTED'
  | 'MATCHED'
  | 'INTERVIEW_SCHEDULED'
  | 'INTERVIEW_PASSED'
  | 'COE_VISA'
  | 'DEPARTED'
  | 'WITHDRAWN'
  | 'REJECTED';

export interface FunnelRates {
  contactedRate: number;
  qualifiedRate: number;
  interviewRate: number;
  departedRate: number;
}

export interface FunnelResult {
  counts: Record<CandidateStage, number>;
  total: number;
  rates: FunnelRates;
  /** True when there were no candidates in range (rates are not meaningful). */
  insufficient: boolean;
}

export interface GroupBucket {
  key: string;
  count: number;
}

export interface JobOrderConversionBucket {
  matchedJobOrderId: string;
  total: number;
  departed: number;
  departedRate: number;
}

export interface AnalyticsRange {
  from?: string;
  to?: string;
  market?: string;
}

/** Recruitment funnel: per-stage counts + derived rates over an optional range. */
export function getFunnel(range: AnalyticsRange = {}): Promise<FunnelResult> {
  return api.get<FunnelResult>('/api/v1/candidates/analytics/funnel', {
    from: range.from,
    to: range.to,
    market: range.market,
  });
}

/** Candidate counts grouped by desired market. */
export function getByMarket(
  range: Omit<AnalyticsRange, 'market'> = {},
): Promise<{ groupBy: string; buckets: GroupBucket[] }> {
  return api.get<{ groupBy: string; buckets: GroupBucket[] }>(
    '/api/v1/candidates/analytics/by-market',
    { from: range.from, to: range.to },
  );
}

/** Candidate counts grouped by acquisition source. */
export function getBySource(
  range: Omit<AnalyticsRange, 'market'> = {},
): Promise<{ groupBy: string; buckets: GroupBucket[] }> {
  return api.get<{ groupBy: string; buckets: GroupBucket[] }>(
    '/api/v1/candidates/analytics/by-source',
    { from: range.from, to: range.to },
  );
}

/** Real "đơn hàng → xuất cảnh" conversion grouped by matched job order. */
export function getConversionByJobOrder(
  range: Omit<AnalyticsRange, 'market'> = {},
): Promise<{ buckets: JobOrderConversionBucket[] }> {
  return api.get<{ buckets: JobOrderConversionBucket[] }>(
    '/api/v1/candidates/analytics/conversion-by-job-order',
    { from: range.from, to: range.to },
  );
}
