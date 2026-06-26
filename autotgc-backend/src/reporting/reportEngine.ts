/**
 * Report_Engine — pure aggregation logic for WEEKLY/MONTHLY company reports
 * (ai-reporting-and-ops-enhancements, Req 1 & 2).
 *
 * Every function here is pure and deterministic (no Gemini, no Date.now, no
 * I/O), so the design's correctness properties can be property-tested directly.
 * Numeric safety mirrors `analytics/scoring.ts` and
 * `recruitment/candidateAnalytics.computeFunnelRates`: a zero denominator
 * surfaces `'INSUFFICIENT_DATA'` instead of emitting NaN/Infinity.
 */
import type {
  RateOrInsufficient,
  ReportContent,
  ReportInputRow,
  ReportPeriod,
  ReportScope,
  ReportType,
} from './types';

export type {
  RateOrInsufficient,
  ReportContent,
  ReportInputRow,
  ReportPeriod,
  ReportScope,
  ReportType,
} from './types';

/** Stable bucket keys for rows that lack a source/stage/market. */
const UNKNOWN_SOURCE = 'UNKNOWN';
const UNKNOWN_STAGE = 'UNKNOWN';
const FALLBACK_MARKET = 'OTHER';

const INSUFFICIENT = 'INSUFFICIENT_DATA' as const;

/** Normalize a possibly blank string to a stable, non-empty key. */
function nonBlank(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/**
 * Keep only rows whose `occurredAt` falls in the half-open interval
 * `[from, to)` (left inclusive, right exclusive), in UTC. Rows with an invalid
 * date are excluded (NaN comparisons are false). (Req 1.1 · Property 1)
 */
export function filterByPeriod(
  rows: readonly ReportInputRow[],
  period: ReportPeriod,
): ReportInputRow[] {
  const from = period.from.getTime();
  const to = period.to.getTime();
  return rows.filter((r) => {
    const t = r.occurredAt.getTime();
    return t >= from && t < to;
  });
}

/**
 * Apply requestor scope. ADMIN sees every row; SALES sees only rows assigned to
 * them (`assignedTo === userId`) — unassigned rows (null/undefined) and rows
 * assigned to others are dropped. (Req 1.5, 1.6 · Property 3)
 */
export function applyScope(
  rows: readonly ReportInputRow[],
  scope: ReportScope,
): ReportInputRow[] {
  if (scope.role === 'ADMIN') return [...rows];
  return rows.filter((r) => r.assignedTo != null && r.assignedTo === scope.userId);
}

/**
 * Average a derived rate over the rows. PerformanceRecord rows labeled
 * `INSUFFICIENT_DATA` are excluded from the average input, and only finite
 * picked values count. When no value remains (denominator 0) the result is
 * `'INSUFFICIENT_DATA'` rather than a division — never NaN/Infinity.
 * (Req 1.2, 1.3 · Property 2)
 */
export function averageRate(
  rows: readonly ReportInputRow[],
  pick: (r: ReportInputRow) => number | undefined,
): RateOrInsufficient {
  const values: number[] = [];
  for (const r of rows) {
    if (r.kind === 'performance' && r.performanceLabel === INSUFFICIENT) continue;
    const v = pick(r);
    if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return INSUFFICIENT;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * True when there are no records to report on (after the caller has already
 * filtered by period and scope). An empty input yields an `INSUFFICIENT_DATA`
 * report with no speculative recommendations. (Req 2.5 · Property 6)
 */
export function isInsufficient(rows: readonly ReportInputRow[]): boolean {
  return rows.length === 0;
}

/** Lead counts grouped by source, sorted by source for determinism. */
function aggregateLeadsBySource(
  leads: readonly ReportInputRow[],
): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const lead of leads) {
    const key = nonBlank(lead.leadSource, UNKNOWN_SOURCE);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([source, count]) => ({ source, count }));
}

/**
 * Candidate stage counts grouped by market, sorted by market for determinism.
 * Each candidate contributes exactly one stage count, so the grand total of all
 * stageCounts equals the candidate row count.
 */
function aggregateFunnelByMarket(
  candidates: readonly ReportInputRow[],
): Array<{ market: string; stageCounts: Record<string, number> }> {
  const byMarket = new Map<string, Map<string, number>>();
  for (const c of candidates) {
    const market = nonBlank(c.candidateMarket, FALLBACK_MARKET);
    const stage = nonBlank(c.candidateStage, UNKNOWN_STAGE);
    let stages = byMarket.get(market);
    if (!stages) {
      stages = new Map<string, number>();
      byMarket.set(market, stages);
    }
    stages.set(stage, (stages.get(stage) ?? 0) + 1);
  }
  return [...byMarket.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([market, stages]) => {
      const stageCounts: Record<string, number> = {};
      for (const stage of [...stages.keys()].sort()) {
        stageCounts[stage] = stages.get(stage) as number;
      }
      return { market, stageCounts };
    });
}

/** Format a rate for human-readable text; INSUFFICIENT_DATA passes through. */
function formatRate(rate: RateOrInsufficient): string {
  return rate === INSUFFICIENT ? 'Chưa đủ dữ liệu' : `${rate.toFixed(2)}%`;
}

/** Deterministic highlight bullets derived purely from the aggregates. */
function buildHighlights(
  publishedCount: number,
  leadsBySource: ReadonlyArray<{ source: string; count: number }>,
  candidateCount: number,
): string[] {
  const leadTotal = leadsBySource.reduce((sum, b) => sum + b.count, 0);
  const highlights: string[] = [
    `Đã xuất bản ${publishedCount} nội dung trong kỳ.`,
    `Tổng số lead thu được: ${leadTotal}.`,
    `Tổng số ứng viên trong phễu: ${candidateCount}.`,
  ];
  if (leadsBySource.length > 0) {
    const top = [...leadsBySource].sort(
      (a, b) => b.count - a.count || (a.source < b.source ? -1 : 1),
    )[0];
    highlights.push(`Nguồn lead nhiều nhất: ${top.source} (${top.count}).`);
  }
  return highlights;
}

/**
 * Deterministic recommendations derived from the aggregates. Returns `[]` when
 * the report is insufficient (no rows) — no speculative advice (Req 2.5).
 */
function buildRecommendations(
  rows: readonly ReportInputRow[],
  publishedCount: number,
  avgConversionRate: RateOrInsufficient,
  leadsBySource: ReadonlyArray<{ source: string; count: number }>,
): string[] {
  if (isInsufficient(rows)) return [];
  const recommendations: string[] = [];
  if (publishedCount === 0) {
    recommendations.push('Chưa có nội dung được xuất bản trong kỳ; cân nhắc tăng tần suất sản xuất.');
  }
  if (avgConversionRate !== INSUFFICIENT && avgConversionRate < 2) {
    recommendations.push('Tỷ lệ chuyển đổi trung bình thấp; cân nhắc tối ưu CTA và nội dung.');
  }
  if (leadsBySource.length > 0) {
    const top = [...leadsBySource].sort(
      (a, b) => b.count - a.count || (a.source < b.source ? -1 : 1),
    )[0];
    recommendations.push(`Ưu tiên đầu tư vào nguồn lead hiệu quả nhất: ${top.source}.`);
  }
  return recommendations;
}

/**
 * Build the deterministic executive summary used when Gemini is unavailable or
 * not configured. Pure function of the aggregated content + type + period, so
 * repeated calls produce byte-identical output (Req 2.4, 2.6 · Property 5).
 */
export function buildDeterministicSummary(
  content: ReportContent,
  type: ReportType,
  period: ReportPeriod,
): string {
  const kind = type === 'WEEKLY' ? 'tuần' : 'tháng';
  const leadTotal = content.leadsBySource.reduce((sum, b) => sum + b.count, 0);
  const candidateTotal = content.recruitmentFunnelByMarket.reduce(
    (sum, m) => sum + Object.values(m.stageCounts).reduce((s, n) => s + n, 0),
    0,
  );
  return [
    `Báo cáo ${kind} (${period.label}).`,
    `Số nội dung đã xuất bản: ${content.contentPerformance.publishedCount}.`,
    `Tỷ lệ chuyển đổi trung bình: ${formatRate(content.contentPerformance.avgConversionRate)}.`,
    `Tỷ lệ tương tác trung bình: ${formatRate(content.contentPerformance.avgEngagementRate)}.`,
    `Tỷ lệ click CTA trung bình: ${formatRate(content.contentPerformance.avgCtaClickRate)}.`,
    `Tổng số lead: ${leadTotal}. Tổng số ứng viên: ${candidateTotal}.`,
  ].join(' ');
}

/**
 * Aggregate the full report content from already filtered + scoped rows.
 * Deterministic and Gemini-free: the executive summary uses
 * `buildDeterministicSummary`. (Req 1.4, 2.2, 2.6 · Property 4, 5)
 */
export function aggregateReport(
  rows: readonly ReportInputRow[],
  type: ReportType,
  period: ReportPeriod,
): ReportContent {
  const performance = rows.filter((r) => r.kind === 'performance');
  const leads = rows.filter((r) => r.kind === 'lead');
  const candidates = rows.filter((r) => r.kind === 'candidate');

  const publishedCount = performance.length;
  const avgConversionRate = averageRate(performance, (r) => r.conversionRate);
  const avgEngagementRate = averageRate(performance, (r) => r.engagementRate);
  const avgCtaClickRate = averageRate(performance, (r) => r.ctaClickRate);

  const leadsBySource = aggregateLeadsBySource(leads);
  const recruitmentFunnelByMarket = aggregateFunnelByMarket(candidates);
  const highlights = buildHighlights(publishedCount, leadsBySource, candidates.length);
  const recommendations = buildRecommendations(
    rows,
    publishedCount,
    avgConversionRate,
    leadsBySource,
  );

  const content: ReportContent = {
    executiveSummary: '',
    contentPerformance: {
      publishedCount,
      avgConversionRate,
      avgEngagementRate,
      avgCtaClickRate,
    },
    recruitmentFunnelByMarket,
    leadsBySource,
    highlights,
    recommendations,
  };

  content.executiveSummary = buildDeterministicSummary(content, type, period);
  return content;
}
