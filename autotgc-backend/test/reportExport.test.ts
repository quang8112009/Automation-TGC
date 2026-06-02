/**
 * Unit tests for reportExport (ai-reporting-and-ops-enhancements, Req 5.4).
 *
 * Verifies the serialized body contains all five Vietnamese section headings
 * and that an INSUFFICIENT_DATA rate renders as "Chưa đủ dữ liệu". Also checks
 * the export wrapper's { filename, contentType, body } contract and that
 * serialization is deterministic.
 */
import { describe, it, expect } from 'vitest';

import {
  REPORT_HEADINGS,
  serializeReport,
  toMarkdown,
  type ReportExportMeta,
} from '../src/reporting/reportExport';
import type { ReportContent } from '../src/reporting/types';

const meta: ReportExportMeta = {
  reportType: 'WEEKLY',
  period: { label: '2024-W23', from: new Date('2024-06-03T00:00:00Z'), to: new Date('2024-06-10T00:00:00Z') },
};

function makeContent(overrides: Partial<ReportContent> = {}): ReportContent {
  return {
    executiveSummary: 'Tóm tắt báo cáo tuần.',
    contentPerformance: {
      publishedCount: 5,
      avgConversionRate: 3.21,
      avgEngagementRate: 12.5,
      avgCtaClickRate: 1.75,
    },
    recruitmentFunnelByMarket: [
      { market: 'JAPAN', stageCounts: { APPLIED: 3, INTERVIEW: 1 } },
    ],
    leadsBySource: [{ source: 'FACEBOOK', count: 4 }],
    highlights: ['Đã xuất bản 5 nội dung trong kỳ.'],
    recommendations: ['Ưu tiên đầu tư vào nguồn lead hiệu quả nhất: FACEBOOK.'],
    ...overrides,
  };
}

describe('reportExport.toMarkdown', () => {
  it('includes all five Vietnamese section headings', () => {
    const body = toMarkdown(makeContent(), meta);
    expect(body).toContain(REPORT_HEADINGS.executiveSummary); // Tóm tắt điều hành
    expect(body).toContain(REPORT_HEADINGS.contentPerformance); // Hiệu năng nội dung
    expect(body).toContain(REPORT_HEADINGS.recruitmentFunnel); // Phễu tuyển dụng theo thị trường
    expect(body).toContain(REPORT_HEADINGS.highlights); // Điểm nổi bật
    expect(body).toContain(REPORT_HEADINGS.recommendations); // Khuyến nghị

    // Explicit literal headings as required by the task.
    expect(body).toContain('Tóm tắt điều hành');
    expect(body).toContain('Hiệu năng nội dung');
    expect(body).toContain('Phễu tuyển dụng theo thị trường');
    expect(body).toContain('Điểm nổi bật');
    expect(body).toContain('Khuyến nghị');
  });

  it('renders INSUFFICIENT_DATA rates as "Chưa đủ dữ liệu"', () => {
    const body = toMarkdown(
      makeContent({
        contentPerformance: {
          publishedCount: 0,
          avgConversionRate: 'INSUFFICIENT_DATA',
          avgEngagementRate: 'INSUFFICIENT_DATA',
          avgCtaClickRate: 'INSUFFICIENT_DATA',
        },
      }),
      meta,
    );
    expect(body).toContain('Chưa đủ dữ liệu');
    expect(body).not.toContain('INSUFFICIENT_DATA');
  });

  it('falls back to "Chưa đủ dữ liệu" for empty sections', () => {
    const body = toMarkdown(
      makeContent({
        recruitmentFunnelByMarket: [],
        leadsBySource: [],
        highlights: [],
        recommendations: [],
      }),
      meta,
    );
    expect(body).toContain('Chưa đủ dữ liệu');
  });

  it('is deterministic for the same input', () => {
    const content = makeContent();
    expect(toMarkdown(content, meta)).toBe(toMarkdown(content, meta));
  });
});

describe('reportExport.serializeReport', () => {
  it('returns a downloadable { filename, contentType, body }', () => {
    const result = serializeReport(makeContent(), meta);
    expect(result.filename).toBe('bao-cao-tuan-2024-W23.md');
    expect(result.contentType).toBe('text/markdown; charset=utf-8');
    expect(result.body).toContain(REPORT_HEADINGS.executiveSummary);
  });

  it('names monthly reports with the monthly prefix', () => {
    const result = serializeReport(makeContent(), {
      reportType: 'MONTHLY',
      period: { label: '2024-06', from: new Date('2024-06-01T00:00:00Z'), to: new Date('2024-07-01T00:00:00Z') },
    });
    expect(result.filename).toBe('bao-cao-thang-2024-06.md');
  });
});
