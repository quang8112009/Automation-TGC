import { api } from '../lib/apiClient';

/**
 * AgentOps telemetry summary for AI text calls (ADMIN-only on the backend:
 * GET /api/v1/ai/telemetry, dashboard/company_stats). Rates/percentiles are the
 * string sentinel 'INSUFFICIENT_DATA' when there are no recorded calls yet.
 */
export interface AiTelemetrySummary {
  totalCalls: number;
  successCount: number;
  aiErrorCount: number;
  unknownErrorCount: number;
  errorRate: number | 'INSUFFICIENT_DATA';
  successRate: number | 'INSUFFICIENT_DATA';
  p50LatencyMs: number | 'INSUFFICIENT_DATA';
  p95LatencyMs: number | 'INSUFFICIENT_DATA';
  errorCodeCounts: Record<string, number>;
}

export function getAiTelemetry(): Promise<AiTelemetrySummary> {
  return api.get<AiTelemetrySummary>('/api/v1/ai/telemetry');
}
