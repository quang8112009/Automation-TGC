/**
 * Trends (/trends, ADMIN) — AI-assisted market trend / keyword discovery for
 * Vietnamese labor-export (XKLĐ). Pick a target market, run research (POST
 * /api/v1/trends/research → shows an AI-vs-grounded badge), and review the
 * discovered signals (Adopt / Dismiss / Review) ranked by demand score.
 *
 * Research is Gemini-OPTIONAL on the backend: when AI is unconfigured it falls
 * back to a deterministic heuristic seed set and returns aiGenerated: false —
 * still a valid result, surfaced via the AiGroundingBadge (not a failure).
 *
 * Endpoints: POST /api/v1/trends/research, GET /api/v1/trends,
 * POST /api/v1/trends/:id/review.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listTrends, researchTrends, reviewTrend } from '../api/marketing';
import { AiGroundingBadge } from '../components/AiGroundingBadge';
import { Empty, ErrorMessage, Loading, SuccessMessage, formatDate } from '../components/ui';
import {
  MARKETING_MARKETS,
  MARKETING_MARKET_LABELS,
  TREND_STATUS_BADGE,
  TREND_STATUS_LABELS,
  marketingMarketLabel,
  trendIntentLabel,
  trendStatusLabel,
} from '../lib/marketing';
import type { TrendStatus } from '../lib/types';

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tất cả trạng thái' },
  { value: 'DISCOVERED', label: TREND_STATUS_LABELS.DISCOVERED },
  { value: 'REVIEWED', label: TREND_STATUS_LABELS.REVIEWED },
  { value: 'ADOPTED', label: TREND_STATUS_LABELS.ADOPTED },
  { value: 'DISMISSED', label: TREND_STATUS_LABELS.DISMISSED },
];

function TrendStatusBadge({ status }: { status: string }) {
  const cls = TREND_STATUS_BADGE[status as TrendStatus] ?? 'badge-gray';
  return <span className={`badge ${cls}`}>{trendStatusLabel(status)}</span>;
}

export function Trends() {
  const queryClient = useQueryClient();
  const [market, setMarket] = useState<string>('JAPAN');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [lastAiGenerated, setLastAiGenerated] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const trendsQuery = useQuery({
    queryKey: ['trends', market, statusFilter],
    queryFn: () => listTrends(market || undefined, statusFilter || undefined),
  });

  const researchMutation = useMutation({
    mutationFn: () => researchTrends(market),
    onSuccess: (res) => {
      setLastAiGenerated(res.aiGenerated);
      void queryClient.invalidateQueries({ queryKey: ['trends'] });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => reviewTrend(id, status),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['trends'] });
    },
    onError: (err) => setActionError(err),
  });

  const trends = trendsQuery.data?.trends ?? [];

  function canReview(status: string): boolean {
    return status === 'DISCOVERED' || status === 'REVIEWED';
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Xu hướng thị trường</h1>
      </div>

      <div className="card">
        <h2 className="card-title">Nghiên cứu xu hướng theo thị trường</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          Chọn thị trường XKLĐ và để hệ thống phát hiện từ khóa / chủ đề nhu cầu cao. Khi AI (Gemini)
          được cấu hình, kết quả do mô hình tạo; nếu chưa cấu hình, hệ thống dùng bộ dữ liệu nền tảng
          xác định sẵn (vẫn là kết quả hợp lệ).
        </div>
        <div className="toolbar">
          <div className="field">
            <label>Thị trường</label>
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              {MARKETING_MARKETS.map((m) => (
                <option key={m} value={m}>
                  {MARKETING_MARKET_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-primary"
            disabled={researchMutation.isPending}
            onClick={() => researchMutation.mutate()}
          >
            {researchMutation.isPending ? 'Đang nghiên cứu…' : 'Nghiên cứu xu hướng'}
          </button>
        </div>
        {researchMutation.error != null && <ErrorMessage error={researchMutation.error} />}
        {researchMutation.data && (
          <SuccessMessage>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>
                Đã tạo {researchMutation.data.created.length} tín hiệu xu hướng cho{' '}
                {marketingMarketLabel(market)}.
              </span>
              {lastAiGenerated !== null && <AiGroundingBadge aiGenerated={lastAiGenerated} />}
            </div>
          </SuccessMessage>
        )}
      </div>

      <div className="toolbar">
        <div className="field">
          <label>Lọc theo thị trường</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            {MARKETING_MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKETING_MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Trạng thái</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {actionError != null && <ErrorMessage error={actionError} />}

      <div className="card">
        {trendsQuery.isLoading ? (
          <Loading label="Đang tải…" />
        ) : trendsQuery.error ? (
          <ErrorMessage error={trendsQuery.error} />
        ) : trends.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Từ khóa</th>
                  <th>Chủ đề</th>
                  <th>Ý định</th>
                  <th>Điểm nhu cầu</th>
                  <th>Trạng thái</th>
                  <th>Phát hiện</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {trends.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.keyword}</strong>
                      {t.rationale && (
                        <div className="muted" style={{ whiteSpace: 'normal', maxWidth: 320 }}>
                          {t.rationale}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 240 }}>{t.topic || '—'}</td>
                    <td>{trendIntentLabel(t.intent)}</td>
                    <td>
                      <span className="badge badge-blue">{Math.round(t.demandScore)}</span>
                    </td>
                    <td>
                      <TrendStatusBadge status={t.status} />
                    </td>
                    <td>{formatDate(t.discoveredAt)}</td>
                    <td>
                      <div className="row-actions">
                        {canReview(t.status) ? (
                          <>
                            <button
                              className="btn btn-sm btn-primary"
                              disabled={reviewMutation.isPending}
                              onClick={() => reviewMutation.mutate({ id: t.id, status: 'ADOPTED' })}
                            >
                              Chọn dùng
                            </button>
                            {t.status === 'DISCOVERED' && (
                              <button
                                className="btn btn-sm"
                                disabled={reviewMutation.isPending}
                                onClick={() =>
                                  reviewMutation.mutate({ id: t.id, status: 'REVIEWED' })
                                }
                              >
                                Đánh dấu đã xem
                              </button>
                            )}
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={reviewMutation.isPending}
                              onClick={() => reviewMutation.mutate({ id: t.id, status: 'DISMISSED' })}
                            >
                              Bỏ qua
                            </button>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty label="Chưa có xu hướng nào. Hãy chạy 'Nghiên cứu xu hướng' cho thị trường này." />
        )}
      </div>
    </div>
  );
}
