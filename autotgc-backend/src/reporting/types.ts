/**
 * Reporting domain types (ai-reporting-and-ops-enhancements).
 *
 * Minimal, framework-free projections so the Report_Engine pure logic can be
 * property-tested directly without Prisma/Fastify. Mirrors the design's TS
 * interfaces. All period math is UTC and half-open: [from, to).
 */

/** Period kind for a Company_Report. */
export type ReportType = 'WEEKLY' | 'MONTHLY';

/** Reporting window. Half-open interval [from, to) in UTC. */
export interface ReportPeriod {
  label: string; // e.g. "2024-W23" | "2024-06"
  from: Date;
  to: Date;
}

/**
 * Minimal projection of a source row the engine reasons over. A single shape
 * covers the three contributing record kinds (no Prisma dependency):
 *  - performance: a scored PerformanceRecord (carries the derived rates + label)
 *  - lead:        a Lead (carries its source)
 *  - candidate:   a CandidateProfile (carries its stage + market)
 *
 * `occurredAt` is the record's effective timestamp (scoredAt | createdAt) used
 * for period filtering. `assignedTo` drives SALES scoping (null = unassigned).
 */
export interface ReportInputRow {
  kind: 'performance' | 'lead' | 'candidate';
  occurredAt: Date;

  // performance-only
  performanceLabel?: string;
  conversionRate?: number;
  engagementRate?: number;
  ctaClickRate?: number;

  // lead-only
  leadSource?: string;

  // candidate-only
  candidateStage?: string;
  /**
   * Candidate's desired market (RecruitmentMarket code). Used to bucket the
   * recruitment funnel by market; absent/blank falls back to 'OTHER'.
   */
  candidateMarket?: string;

  // SALES scoping (performance rows are typically unassigned -> dropped for SALES)
  assignedTo?: string | null;
}

/** A derived rate that may be unavailable when its denominator is empty. */
export type RateOrInsufficient = number | 'INSUFFICIENT_DATA';

/** Structured content of a Company_Report (serialized into CompanyReport.content). */
export interface ReportContent {
  executiveSummary: string;
  contentPerformance: {
    publishedCount: number;
    avgConversionRate: RateOrInsufficient;
    avgEngagementRate: RateOrInsufficient;
    avgCtaClickRate: RateOrInsufficient;
  };
  recruitmentFunnelByMarket: Array<{ market: string; stageCounts: Record<string, number> }>;
  leadsBySource: Array<{ source: string; count: number }>;
  highlights: string[];
  recommendations: string[];
}

/** Requestor scope. SALES is assigned-only; ADMIN is company-wide. */
export interface ReportScope {
  role: 'ADMIN' | 'SALES';
  userId: string;
}
