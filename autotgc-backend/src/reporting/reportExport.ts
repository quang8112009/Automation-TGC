/**
 * Report export — pure serialization of a Company_Report into a structured,
 * downloadable plain-text/Markdown representation
 * (ai-reporting-and-ops-enhancements, Req 5.4).
 *
 * Framework-free and deterministic: given the same `ReportContent` + metadata
 * it always produces byte-identical output (no Gemini, no Date.now, no I/O).
 * `ReportService.export` wraps `serializeReport` to satisfy its
 * `{ filename, contentType, body }` contract; `toMarkdown` is exposed for
 * callers that only need the text body.
 *
 * Headings are Vietnamese to match the product language. Any
 * `RateOrInsufficient` carrying `'INSUFFICIENT_DATA'` renders as the
 * human-readable "Chưa đủ dữ liệu" rather than a misleading number.
 */
import type {
  RateOrInsufficient,
  ReportContent,
  ReportPeriod,
  ReportType,
} from './types';

/** Metadata needed to title and name the exported report. */
export interface ReportExportMeta {
  reportType: ReportType;
  period: ReportPeriod;
}

/** Result shape consumed by `ReportService.export` (Req 5.4). */
export interface ReportExport {
  filename: string;
  contentType: string;
  body: string;
}

/** Section headings (Vietnamese), exported so tests/callers can reuse them. */
export const REPORT_HEADINGS = {
  executiveSummary: 'Tóm tắt điều hành',
  contentPerformance: 'Hiệu năng nội dung',
  recruitmentFunnel: 'Phễu tuyển dụng theo thị trường',
  highlights: 'Điểm nổi bật',
  recommendations: 'Khuyến nghị',
} as const;

/** Shown wherever a value/section is unavailable (INSUFFICIENT_DATA or empty). */
const INSUFFICIENT_TEXT = 'Chưa đủ dữ liệu';

const CONTENT_TYPE = 'text/markdown; charset=utf-8';

/** Format a derived rate for display; INSUFFICIENT_DATA → "Chưa đủ dữ liệu". */
function formatRate(rate: RateOrInsufficient): string {
  return rate === 'INSUFFICIENT_DATA' ? INSUFFICIENT_TEXT : `${rate.toFixed(2)}%`;
}

/** Human-readable report kind for titles. */
function reportKindLabel(type: ReportType): string {
  return type === 'WEEKLY' ? 'Báo cáo tuần' : 'Báo cáo tháng';
}

/** Slug used in the download filename; keeps only filename-safe characters. */
function slugifyLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'bao-cao';
}

/** Render a bullet list, falling back to the insufficient-data line when empty. */
function bulletList(lines: readonly string[]): string[] {
  if (lines.length === 0) return [INSUFFICIENT_TEXT];
  return lines.map((line) => `- ${line}`);
}

/**
 * Serialize a `ReportContent` (plus type + period metadata) into a structured
 * Markdown document. Pure and deterministic. Always contains all five
 * Vietnamese section headings (Req 5.4).
 */
export function toMarkdown(content: ReportContent, meta: ReportExportMeta): string {
  const { reportType, period } = meta;
  const cp = content.contentPerformance;

  const lines: string[] = [];

  // Title
  lines.push(`# ${reportKindLabel(reportType)} (${period.label})`);
  lines.push('');

  // 1. Executive summary
  lines.push(`## ${REPORT_HEADINGS.executiveSummary}`);
  lines.push('');
  lines.push(content.executiveSummary.trim().length > 0 ? content.executiveSummary : INSUFFICIENT_TEXT);
  lines.push('');

  // 2. Content performance
  lines.push(`## ${REPORT_HEADINGS.contentPerformance}`);
  lines.push('');
  lines.push(`- Số nội dung đã xuất bản: ${cp.publishedCount}`);
  lines.push(`- Tỷ lệ chuyển đổi trung bình: ${formatRate(cp.avgConversionRate)}`);
  lines.push(`- Tỷ lệ tương tác trung bình: ${formatRate(cp.avgEngagementRate)}`);
  lines.push(`- Tỷ lệ click CTA trung bình: ${formatRate(cp.avgCtaClickRate)}`);
  lines.push('');
  lines.push('### Lead theo nguồn');
  lines.push('');
  lines.push(
    ...bulletList(content.leadsBySource.map((b) => `${b.source}: ${b.count}`)),
  );
  lines.push('');

  // 3. Recruitment funnel by market
  lines.push(`## ${REPORT_HEADINGS.recruitmentFunnel}`);
  lines.push('');
  if (content.recruitmentFunnelByMarket.length === 0) {
    lines.push(INSUFFICIENT_TEXT);
    lines.push('');
  } else {
    for (const market of content.recruitmentFunnelByMarket) {
      lines.push(`### ${market.market}`);
      lines.push('');
      const stageLines = Object.entries(market.stageCounts).map(
        ([stage, count]) => `${stage}: ${count}`,
      );
      lines.push(...bulletList(stageLines));
      lines.push('');
    }
  }

  // 4. Highlights
  lines.push(`## ${REPORT_HEADINGS.highlights}`);
  lines.push('');
  lines.push(...bulletList(content.highlights));
  lines.push('');

  // 5. Recommendations
  lines.push(`## ${REPORT_HEADINGS.recommendations}`);
  lines.push('');
  lines.push(...bulletList(content.recommendations));
  lines.push('');

  return lines.join('\n');
}

/**
 * Serialize a report into a downloadable artifact:
 * `{ filename, contentType, body }`. Pure wrapper around `toMarkdown` used by
 * `ReportService.export` (Req 5.4).
 */
export function serializeReport(
  content: ReportContent,
  meta: ReportExportMeta,
): ReportExport {
  const prefix = meta.reportType === 'WEEKLY' ? 'bao-cao-tuan' : 'bao-cao-thang';
  return {
    filename: `${prefix}-${slugifyLabel(meta.period.label)}.md`,
    contentType: CONTENT_TYPE,
    body: toMarkdown(content, meta),
  };
}
