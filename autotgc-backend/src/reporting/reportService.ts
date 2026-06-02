/**
 * ReportService — I/O + lifecycle for company WEEKLY/MONTHLY reports
 * (ai-reporting-and-ops-enhancements, Req 2.1, 2.3, 3.1, 3.4, 3.5, 3.6, 5.1–5.4).
 *
 * The heavy lifting (period filtering, scoping, aggregation, deterministic
 * summary, state transitions, export serialization) lives in the pure modules
 * `reportEngine.ts`, `reportStateMachine.ts`, and `reportExport.ts`. This
 * service only reads Prisma rows, projects them into the engine's
 * framework-free `ReportInputRow` shape, drives the optional Gemini
 * interpretation seam (with a deterministic fallback that never throws), and
 * persists/queries `CompanyReport` rows while enforcing RBAC.
 *
 * Mirrors the existing `FeedbackEngine` + `InsightService` + `AuditLog`
 * patterns: Gemini is optional with a deterministic fallback (`aiGenerated`
 * flag), status changes go ONLY through the guarded `reportTransition`
 * (illegal → 409), approving writes an append-only `AuditLog` entry, and every
 * thrown error is a typed `AppError` carrying an allowed status code.
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import type { AuthInfo } from '../http/authMiddleware';
import type { ContentGenerator } from '../strategy/personaService';
import { ConflictError, ForbiddenError, NotFoundError } from '../infra/errors';
import { AuditLog } from '../analytics/auditLog';
import {
  aggregateReport,
  applyScope,
  buildDeterministicSummary,
  isInsufficient,
} from './reportEngine';
import { reportTransition } from './reportStateMachine';
import type { ReportStatus } from './reportStateMachine';
import { serializeReport } from './reportExport';
import type { ReportExport } from './reportExport';
import type {
  ReportContent,
  ReportInputRow,
  ReportPeriod,
  ReportScope,
  ReportType,
} from './types';

/** Read view of a persisted CompanyReport (content already narrowed). */
export interface CompanyReportView {
  id: string;
  reportType: ReportType;
  periodFrom: Date;
  periodTo: Date;
  periodLabel: string;
  status: ReportStatus;
  content: ReportContent;
  aiGenerated: boolean;
  scopeUserId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Filter for listing reports. */
export interface ReportListFilter {
  reportType?: ReportType;
  status?: ReportStatus;
}

/** Statuses that are still editable (Req 3.4). */
const EDITABLE_STATUSES: ReadonlySet<ReportStatus> = new Set<ReportStatus>([
  'DRAFT',
  'IN_REVIEW',
]);

/** Minimal row shape returned by Prisma (kept local to avoid a generated-type import). */
interface CompanyReportRow {
  id: string;
  reportType: string;
  periodFrom: Date;
  periodTo: Date;
  periodLabel: string;
  status: string;
  content: unknown;
  aiGenerated: boolean;
  scopeUserId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ReportService {
  private readonly audit: AuditLog;

  constructor(
    private readonly prisma: PrismaClient,
    /** Optional Gemini seam (GeminiClient satisfies this structurally). */
    private readonly gemini?: ContentGenerator,
    private readonly clock: Clock = systemClock,
  ) {
    this.audit = new AuditLog(prisma);
  }

  /**
   * Generate a report for a period under the requestor's scope. Reads the
   * contributing rows in `[from, to)`, projects + scopes them, aggregates
   * deterministically, then — only when a Gemini seam is configured and the
   * report is not empty — replaces the executive summary with an AI rendering
   * (`aiGenerated = true`). Any Gemini failure (incl. AI_NOT_CONFIGURED) falls
   * back to the deterministic summary (`aiGenerated = false`) without throwing.
   * Empty input yields an `INSUFFICIENT_DATA` report with no recommendations;
   * otherwise the report is persisted in `DRAFT` (review mode). (Req 2.x, 3.1)
   */
  async generateForPeriod(
    type: ReportType,
    period: ReportPeriod,
    scope: ReportScope,
  ): Promise<CompanyReportView> {
    const rows = await this.loadRows(period);
    const scoped = applyScope(rows, scope);

    const content = aggregateReport(scoped, type, period);

    let status: ReportStatus;
    let aiGenerated = false;

    if (isInsufficient(scoped)) {
      // No valid records → INSUFFICIENT_DATA, no speculative recommendations
      // (aggregateReport already returns recommendations: [] for empty input).
      status = 'INSUFFICIENT_DATA';
    } else {
      status = 'DRAFT';
      aiGenerated = await this.applyAiSummary(content, type, period);
    }

    const row = await this.prisma.companyReport.create({
      data: {
        reportType: type,
        periodFrom: period.from,
        periodTo: period.to,
        periodLabel: period.label,
        status,
        content: content as object,
        aiGenerated,
        scopeUserId: scope.role === 'SALES' ? scope.userId : null,
        createdBy: scope.userId,
      },
    });

    return this.toView(row as CompanyReportRow);
  }

  /**
   * Read a single report. SALES may only read APPROVED reports; any other
   * status (or none) is a 403 for SALES (Req 5.2, 5.3). ADMIN reads all (5.1).
   */
  async get(id: string, actor: AuthInfo): Promise<CompanyReportView> {
    const row = await this.requireReport(id);
    if (actor.role === 'SALES' && row.status !== 'APPROVED') {
      throw new ForbiddenError('Report is not available', 'REPORT_FORBIDDEN');
    }
    return this.toView(row);
  }

  /**
   * List reports filtered by type/status. SALES is constrained to APPROVED
   * reports regardless of the requested status filter (Req 5.2); ADMIN sees all
   * (Req 5.1).
   */
  async list(
    filter: ReportListFilter,
    actor: AuthInfo,
  ): Promise<{ items: CompanyReportView[]; total: number }> {
    const where: { reportType?: ReportType; status?: ReportStatus } = {};
    if (filter.reportType) where.reportType = filter.reportType;
    if (filter.status) where.status = filter.status;
    // SALES: hard-restrict to APPROVED, overriding any requested status.
    if (actor.role === 'SALES') where.status = 'APPROVED';

    const [rows, total] = await Promise.all([
      this.prisma.companyReport.findMany({
        where,
        orderBy: { periodFrom: 'desc' },
      }),
      this.prisma.companyReport.count({ where }),
    ]);

    return { items: rows.map((r) => this.toView(r as CompanyReportRow)), total };
  }

  /**
   * Update report content. Only DRAFT/IN_REVIEW reports are editable; any other
   * status → 409 (Req 3.4). SALES is denied (403) (Req 5.3). The partial content
   * is merged shallowly over the persisted content.
   */
  async updateContent(
    id: string,
    content: Partial<ReportContent>,
    actor: AuthInfo,
  ): Promise<CompanyReportView> {
    if (actor.role === 'SALES') {
      throw new ForbiddenError('Editing reports is not permitted', 'REPORT_FORBIDDEN');
    }
    const row = await this.requireReport(id);
    if (!EDITABLE_STATUSES.has(row.status as ReportStatus)) {
      throw new ConflictError('Report is not editable in its current status', 'REPORT_NOT_EDITABLE');
    }

    const merged: ReportContent = { ...this.narrowContent(row.content), ...content };
    const updated = await this.prisma.companyReport.update({
      where: { id },
      data: { content: merged as object },
    });
    return this.toView(updated as CompanyReportRow);
  }

  /**
   * Transition a report's status through the guarded state machine. Illegal
   * transitions → 409 with the status unchanged (Req 3.3). SALES is denied (403)
   * (Req 5.3). A transition into APPROVED appends an Audit_Log entry recording
   * the report id, actor, and timestamp (Req 3.5).
   */
  async transition(
    id: string,
    target: ReportStatus,
    actor: AuthInfo,
  ): Promise<CompanyReportView> {
    if (actor.role === 'SALES') {
      throw new ForbiddenError('Changing report status is not permitted', 'REPORT_FORBIDDEN');
    }
    const row = await this.requireReport(id);
    const result = reportTransition(row.status as ReportStatus, target);
    if (!result.ok) {
      throw new ConflictError('Illegal report status transition', 'REPORT_TRANSITION_ILLEGAL');
    }

    const updated = await this.prisma.companyReport.update({
      where: { id },
      data: { status: result.status },
    });

    if (result.status === 'APPROVED') {
      await this.audit.append('REPORT_APPROVED', id, actor.userId, {
        reportType: row.reportType,
        periodLabel: row.periodLabel,
        at: this.clock.now().toISOString(),
      });
    }

    return this.toView(updated as CompanyReportRow);
  }

  /**
   * Export an APPROVED report as a downloadable, structured text artifact
   * (Req 5.4). Non-APPROVED reports cannot be exported → 409.
   */
  async export(id: string, actor: AuthInfo): Promise<ReportExport> {
    const row = await this.requireReport(id);
    if (actor.role === 'SALES' && row.status !== 'APPROVED') {
      throw new ForbiddenError('Report is not available', 'REPORT_FORBIDDEN');
    }
    if (row.status !== 'APPROVED') {
      throw new ConflictError('Only approved reports can be exported', 'REPORT_NOT_APPROVED');
    }
    return serializeReport(this.narrowContent(row.content), {
      reportType: row.reportType as ReportType,
      period: { label: row.periodLabel, from: row.periodFrom, to: row.periodTo },
    });
  }

  // --- internals -------------------------------------------------------------

  /**
   * Load and project the contributing rows for a period into the engine's
   * framework-free `ReportInputRow` shape. Period filtering happens at the DB
   * (half-open `[from, to)` via `gte`/`lt`).
   */
  private async loadRows(period: ReportPeriod): Promise<ReportInputRow[]> {
    const window = { gte: period.from, lt: period.to };
    const [performance, leads, candidates] = await Promise.all([
      this.prisma.performanceRecord.findMany({ where: { scoredAt: window } }),
      this.prisma.lead.findMany({ where: { createdAt: window } }),
      this.prisma.candidateProfile.findMany({ where: { createdAt: window } }),
    ]);

    const rows: ReportInputRow[] = [];

    for (const p of performance) {
      rows.push({
        kind: 'performance',
        occurredAt: p.scoredAt,
        performanceLabel: p.performanceLabel,
        conversionRate: p.conversionRate,
        engagementRate: p.engagementRate,
        ctaClickRate: p.ctaClickRate,
        // PerformanceRecord has no owner → unassigned (dropped for SALES scope).
        assignedTo: null,
      });
    }

    for (const l of leads) {
      rows.push({
        kind: 'lead',
        occurredAt: l.createdAt,
        leadSource: l.source,
        assignedTo: l.assignedTo ?? null,
      });
    }

    for (const c of candidates) {
      rows.push({
        kind: 'candidate',
        occurredAt: c.createdAt,
        candidateStage: c.stage,
        candidateMarket: c.desiredMarket ?? undefined,
        assignedTo: c.assignedTo ?? null,
      });
    }

    return rows;
  }

  /**
   * Replace the executive summary with a Gemini rendering when the seam is
   * configured; returns whether AI was actually used. Any failure (including
   * AI_NOT_CONFIGURED) leaves the deterministic summary in place and returns
   * false — it never throws. (Req 2.3, 2.4)
   */
  private async applyAiSummary(
    content: ReportContent,
    type: ReportType,
    period: ReportPeriod,
  ): Promise<boolean> {
    if (!this.gemini) return false;
    try {
      const text = await this.gemini.generateContent(this.buildSummaryPrompt(content, type, period));
      if (text && text.trim().length > 0) {
        content.executiveSummary = text.trim();
        return true;
      }
    } catch {
      // Fall through to the deterministic summary (covers AI_NOT_CONFIGURED).
    }
    // Ensure a deterministic summary is present even if AI returned blank.
    content.executiveSummary = buildDeterministicSummary(content, type, period);
    return false;
  }

  /**
   * Deterministic grounding prompt for the executive summary. Built purely from
   * the aggregated content — it never embeds secrets (Req 7.5 spirit) and asks
   * for a concise Vietnamese summary.
   */
  private buildSummaryPrompt(
    content: ReportContent,
    type: ReportType,
    period: ReportPeriod,
  ): string {
    const cp = content.contentPerformance;
    const leadTotal = content.leadsBySource.reduce((sum, b) => sum + b.count, 0);
    const candidateTotal = content.recruitmentFunnelByMarket.reduce(
      (sum, m) => sum + Object.values(m.stageCounts).reduce((s, n) => s + n, 0),
      0,
    );
    const rate = (r: number | 'INSUFFICIENT_DATA'): string =>
      r === 'INSUFFICIENT_DATA' ? 'chưa đủ dữ liệu' : `${r.toFixed(2)}%`;

    return [
      'Bạn là trợ lý phân tích cho một nền tảng marketing/tuyển dụng (XKLĐ).',
      `Hãy viết một đoạn tóm tắt điều hành ngắn gọn bằng tiếng Việt cho báo cáo ${type === 'WEEKLY' ? 'tuần' : 'tháng'} (${period.label}).`,
      'Chỉ dựa trên các số liệu tổng hợp sau, không bịa thêm số liệu:',
      `- Số nội dung đã xuất bản: ${cp.publishedCount}`,
      `- Tỷ lệ chuyển đổi trung bình: ${rate(cp.avgConversionRate)}`,
      `- Tỷ lệ tương tác trung bình: ${rate(cp.avgEngagementRate)}`,
      `- Tỷ lệ click CTA trung bình: ${rate(cp.avgCtaClickRate)}`,
      `- Tổng số lead: ${leadTotal}`,
      `- Tổng số ứng viên trong phễu: ${candidateTotal}`,
    ].join('\n');
  }

  private async requireReport(id: string): Promise<CompanyReportRow> {
    const row = await this.prisma.companyReport.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundError('Report not found', 'REPORT_NOT_FOUND');
    }
    return row as CompanyReportRow;
  }

  /** Narrow a Prisma Json content column back to ReportContent. */
  private narrowContent(value: unknown): ReportContent {
    return value as ReportContent;
  }

  private toView(row: CompanyReportRow): CompanyReportView {
    return {
      id: row.id,
      reportType: row.reportType as ReportType,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      periodLabel: row.periodLabel,
      status: row.status as ReportStatus,
      content: this.narrowContent(row.content),
      aiGenerated: row.aiGenerated,
      scopeUserId: row.scopeUserId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
