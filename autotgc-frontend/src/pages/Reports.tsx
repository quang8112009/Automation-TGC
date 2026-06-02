/**
 * Reports (/reports) — company WEEKLY/MONTHLY reports (báo cáo công ty).
 *
 * ADMIN: generate a DRAFT report ("Tạo báo cáo"), drive its lifecycle through
 * the guarded state machine (DRAFT → IN_REVIEW → APPROVED, plus archive), and
 * export an APPROVED report as a markdown file ("Tải xuống"). SALES is
 * read-only and only ever sees APPROVED reports (the backend enforces this);
 * write controls are hidden via the role from AuthContext.
 *
 * Rates that come back as 'INSUFFICIENT_DATA' render as "Chưa đủ dữ liệu".
 *
 * Endpoints: GET /api/v1/reports, GET /api/v1/reports/:id,
 * POST /api/v1/reports/generate, PUT /api/v1/reports/:id,
 * POST /api/v1/reports/:id/transition, GET /api/v1/reports/:id/export.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  exportReport,
  generateReport,
  getReport,
  listReports,
  transitionReport,
} from '../api/reports';
import type {
  CompanyReportView,
  RateOrInsufficient,
  ReportFilters,
  ReportStatus,
  ReportType,
} from '../api/reports';
import { useAuth } from '../auth/AuthContext';
import {
  Empty,
  ErrorMessage,
  Loading,
  Modal,
  SuccessMessage,
  formatDate,
} from '../components/ui';
import { AiGroundingBadge } from '../components/AiGroundingBadge';
import { Icon } from '../components/Icon';

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  WEEKLY: 'Tuần',
  MONTHLY: 'Tháng',
};

const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  DRAFT: 'Bản nháp',
  IN_REVIEW: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  ARCHIVED: 'Đã lưu trữ',
  INSUFFICIENT_DATA: 'Chưa đủ dữ liệu',
};

const REPORT_STATUS_BADGE: Record<ReportStatus, string> = {
  DRAFT: 'badge-gray',
  IN_REVIEW: 'badge-yellow',
  APPROVED: 'badge-green',
  ARCHIVED: 'badge-gray',
  INSUFFICIENT_DATA: 'badge-red',
};

/** Allowed next statuses mirror the backend Report_State_Machine. */
const NEXT_STATUSES: Record<ReportStatus, ReportStatus[]> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['APPROVED', 'ARCHIVED'],
  APPROVED: [],
  ARCHIVED: [],
  INSUFFICIENT_DATA: [],
};

const TRANSITION_LABELS: Record<ReportStatus, string> = {
  IN_REVIEW: 'Gửi duyệt',
  APPROVED: 'Phê duyệt',
  ARCHIVED: 'Lưu trữ',
  DRAFT: 'Chuyển nháp',
  INSUFFICIENT_DATA: 'Chưa đủ dữ liệu',
};

function ReportStatusBadge({ status }: { status: ReportStatus }) {
  return (
    <span className={`badge ${REPORT_STATUS_BADGE[status]}`}>
      {REPORT_STATUS_LABELS[status]}
    </span>
  );
}

/** Render a derived rate as a percentage, or "Chưa đủ dữ liệu" when missing. */
function formatRate(rate: RateOrInsufficient): string {
  if (rate === 'INSUFFICIENT_DATA') return 'Chưa đủ dữ liệu';
  return `${rate.toFixed(2)}%`;
}

const REPORT_TYPES: ReportType[] = ['WEEKLY', 'MONTHLY'];
const REPORT_STATUSES: ReportStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'ARCHIVED',
  'INSUFFICIENT_DATA',
];

export function Reports() {
  const { role } = useAuth();
  const isAdmin = role === 'ADMIN';
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<ReportFilters>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const reportsQuery = useQuery({
    queryKey: ['reports', filters],
    queryFn: () => listReports(filters),
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['reports'] });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Báo cáo công ty</div>
          <h1 className="page-title">Báo cáo</h1>
        </div>
        {isAdmin && (
          <div className="row-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setActionError(null);
                setActionMsg(null);
                setShowGenerate(true);
              }}
            >
              <Icon name="plus" size={16} />
              Tạo báo cáo
            </button>
          </div>
        )}
      </div>

      {actionMsg && <SuccessMessage>{actionMsg}</SuccessMessage>}
      {actionError != null && <ErrorMessage error={actionError} />}

      {/* Filters */}
      <div className="toolbar">
        <div className="field">
          <label>Loại báo cáo</label>
          <select
            value={filters.reportType ?? ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                reportType: (e.target.value || undefined) as ReportType | undefined,
              }))
            }
          >
            <option value="">Tất cả</option>
            {REPORT_TYPES.map((t) => (
              <option key={t} value={t}>
                {REPORT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        {isAdmin && (
          <div className="field">
            <label>Trạng thái</label>
            <select
              value={filters.status ?? ''}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  status: (e.target.value || undefined) as ReportStatus | undefined,
                }))
              }
            >
              <option value="">Tất cả</option>
              {REPORT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {REPORT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        )}
        <button className="btn" onClick={() => setFilters({})}>
          Đặt lại
        </button>
      </div>

      {/* Table */}
      <div className="card">
        {reportsQuery.isLoading ? (
          <Loading />
        ) : reportsQuery.error ? (
          <ErrorMessage error={reportsQuery.error} />
        ) : reportsQuery.data && reportsQuery.data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Kỳ</th>
                  <th>Loại</th>
                  <th>Trạng thái</th>
                  <th>Nguồn nội dung</th>
                  <th>Tạo lúc</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {reportsQuery.data.items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.periodLabel}</td>
                    <td>{REPORT_TYPE_LABELS[r.reportType]}</td>
                    <td>
                      <ReportStatusBadge status={r.status} />
                    </td>
                    <td>
                      <AiGroundingBadge aiGenerated={r.aiGenerated} />
                    </td>
                    <td>{formatDate(r.createdAt)}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => setOpenId(r.id)}>
                        Xem
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty label="Chưa có báo cáo nào." />
        )}
      </div>

      {openId && (
        <ReportDetailModal
          id={openId}
          isAdmin={isAdmin}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            refresh();
          }}
        />
      )}

      {showGenerate && isAdmin && (
        <GenerateReportModal
          onClose={() => setShowGenerate(false)}
          onGenerated={(report) => {
            setShowGenerate(false);
            setActionMsg(
              `Đã tạo báo cáo ${REPORT_TYPE_LABELS[report.reportType]} (${report.periodLabel}).`,
            );
            refresh();
            setOpenId(report.id);
          }}
        />
      )}
    </div>
  );
}

function GenerateReportModal({
  onClose,
  onGenerated,
}: {
  onClose: () => void;
  onGenerated: (report: CompanyReportView) => void;
}) {
  const [reportType, setReportType] = useState<ReportType>('WEEKLY');

  const mutation = useMutation({
    mutationFn: () => generateReport({ reportType }),
    onSuccess: onGenerated,
  });

  return (
    <Modal title="Tạo báo cáo" onClose={onClose}>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="muted" style={{ marginBottom: 12 }}>
        Hệ thống tổng hợp dữ liệu của kỳ vừa kết thúc thành một báo cáo bản nháp. Báo cáo
        cần được phê duyệt trước khi xuất bản.
      </div>
      <div className="field">
        <label>Loại báo cáo</label>
        <select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)}>
          {REPORT_TYPES.map((t) => (
            <option key={t} value={t}>
              {REPORT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Hủy
        </button>
        <button
          className="btn btn-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang tạo…' : 'Tạo báo cáo'}
        </button>
      </div>
    </Modal>
  );
}

function ReportDetailModal({
  id,
  isAdmin,
  onClose,
  onChanged,
}: {
  id: string;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['reports', 'detail', id],
    queryFn: () => getReport(id),
  });

  const transitionMutation = useMutation({
    mutationFn: (target: ReportStatus) => transitionReport(id, target),
    onSuccess: (updated) => {
      setMessage(`Đã chuyển trạng thái: ${REPORT_STATUS_LABELS[updated.status]}.`);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['reports', 'detail', id] });
      onChanged();
    },
    onError: (err) => setActionError(err),
  });

  async function handleExport() {
    setActionError(null);
    setExportBusy(true);
    try {
      const { blob, filename } = await exportReport(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `report-${id}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err);
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <Modal title="Chi tiết báo cáo" onClose={onClose}>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          {message && <SuccessMessage>{message}</SuccessMessage>}
          {actionError != null && <ErrorMessage error={actionError} />}

          <dl className="kv">
            <dt>Kỳ</dt>
            <dd>{data.periodLabel}</dd>
            <dt>Loại</dt>
            <dd>{REPORT_TYPE_LABELS[data.reportType]}</dd>
            <dt>Trạng thái</dt>
            <dd>
              <ReportStatusBadge status={data.status} />
            </dd>
            <dt>Nguồn nội dung</dt>
            <dd>
              <AiGroundingBadge aiGenerated={data.aiGenerated} />
            </dd>
            <dt>Khoảng thời gian</dt>
            <dd>
              {formatDate(data.periodFrom)} → {formatDate(data.periodTo)}
            </dd>
            <dt>Tạo lúc</dt>
            <dd>{formatDate(data.createdAt)}</dd>
          </dl>

          <ReportContentView report={data} />

          <div className="modal-actions">
            {data.status === 'APPROVED' && (
              <button className="btn" disabled={exportBusy} onClick={handleExport}>
                <Icon name="file-text" size={16} />
                {exportBusy ? 'Đang tải…' : 'Tải xuống (Markdown)'}
              </button>
            )}
            {isAdmin &&
              NEXT_STATUSES[data.status].map((target) => (
                <button
                  key={target}
                  className={target === 'APPROVED' ? 'btn btn-primary' : 'btn'}
                  disabled={transitionMutation.isPending}
                  onClick={() => transitionMutation.mutate(target)}
                >
                  {TRANSITION_LABELS[target]}
                </button>
              ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function ReportContentView({ report }: { report: CompanyReportView }) {
  const { content } = report;
  const cp = content.contentPerformance;

  return (
    <>
      <h3 style={{ marginTop: 18 }}>Tóm tắt điều hành</h3>
      <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>
        {content.executiveSummary || '—'}
      </pre>

      <h3 style={{ marginTop: 18 }}>Hiệu suất nội dung</h3>
      <dl className="kv">
        <dt>Số nội dung đã xuất bản</dt>
        <dd>{cp.publishedCount}</dd>
        <dt>Tỷ lệ chuyển đổi TB</dt>
        <dd>{formatRate(cp.avgConversionRate)}</dd>
        <dt>Tỷ lệ tương tác TB</dt>
        <dd>{formatRate(cp.avgEngagementRate)}</dd>
        <dt>Tỷ lệ click CTA TB</dt>
        <dd>{formatRate(cp.avgCtaClickRate)}</dd>
      </dl>

      <h3 style={{ marginTop: 18 }}>Phễu tuyển dụng theo thị trường</h3>
      {content.recruitmentFunnelByMarket.length === 0 ? (
        <div className="muted">Chưa đủ dữ liệu.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Thị trường</th>
                <th>Giai đoạn</th>
              </tr>
            </thead>
            <tbody>
              {content.recruitmentFunnelByMarket.map((m) => (
                <tr key={m.market}>
                  <td>{m.market}</td>
                  <td>
                    <div className="inline-list">
                      {Object.entries(m.stageCounts).map(([stage, count]) => (
                        <span key={stage} className="badge badge-blue">
                          {stage}: {count}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ marginTop: 18 }}>Lead theo nguồn</h3>
      {content.leadsBySource.length === 0 ? (
        <div className="muted">Chưa đủ dữ liệu.</div>
      ) : (
        <div className="inline-list">
          {content.leadsBySource.map((b) => (
            <span key={b.source} className="badge badge-blue">
              {b.source || '(không rõ)'}: {b.count}
            </span>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: 18 }}>Điểm nổi bật</h3>
      {content.highlights.length === 0 ? (
        <div className="muted">Không có điểm nổi bật.</div>
      ) : (
        <ul>
          {content.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}

      <h3 style={{ marginTop: 18 }}>Khuyến nghị</h3>
      {content.recommendations.length === 0 ? (
        <div className="muted">Chưa đủ dữ liệu để đưa ra khuyến nghị.</div>
      ) : (
        <ul>
          {content.recommendations.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </>
  );
}
