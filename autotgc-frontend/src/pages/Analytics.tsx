/**
 * Analytics — recruitment-funnel analytics for the labor-export (XKLĐ) pipeline
 * (customer: Thanh Giang). Visualizes the REAL conversion path
 * NEW → CONSULTING → … → DEPARTED ("đơn hàng → xuất cảnh"), plus candidate
 * distribution by market and source, and per-job-order departure conversion.
 *
 * Data: GET /api/v1/candidates/analytics/{funnel,by-market,by-source,
 * conversion-by-job-order}. SALES is auto-scoped server-side to assigned
 * candidates. Live-refreshes via react-query invalidation on the realtime
 * 'notification' (candidate_stage_changed) stream.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getByMarket,
  getBySource,
  getConversionByJobOrder,
  getFunnel,
} from '../api/analytics';
import type { CandidateStage } from '../api/analytics';
import { BarChart, DonutChart, FunnelChart } from '../components/charts';
import type { FunnelStage } from '../components/charts';
import { ErrorMessage, Loading, StatCard, Empty } from '../components/ui';
import { useRealtime } from '../realtime/RealtimeContext';
import {
  CANDIDATE_STAGE_LABELS,
  MARKETS,
  marketLabel,
} from '../lib/recruitment';

/** Forward funnel order (terminal WITHDRAWN/REJECTED shown separately). */
const FUNNEL_ORDER: CandidateStage[] = [
  'NEW',
  'CONSULTING',
  'PROFILE_COLLECTED',
  'MATCHED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_PASSED',
  'COE_VISA',
  'DEPARTED',
];

export function Analytics() {
  const queryClient = useQueryClient();
  const { subscribe } = useRealtime();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [market, setMarket] = useState('');

  // Applied filters (only change on "Apply" so charts don't refetch per keypress).
  const [applied, setApplied] = useState<{ from?: string; to?: string; market?: string }>({});

  // Live-refresh analytics when a candidate stage-change notification arrives.
  useEffect(() => {
    return subscribe((event) => {
      if (event.topic === 'notification' && event.type === 'candidate_stage_changed') {
        void queryClient.invalidateQueries({ queryKey: ['candidateAnalytics'] });
      }
    });
  }, [subscribe, queryClient]);

  const rangeKey = useMemo(
    () => [applied.from ?? '', applied.to ?? '', applied.market ?? ''],
    [applied],
  );

  const funnelQ = useQuery({
    queryKey: ['candidateAnalytics', 'funnel', ...rangeKey],
    queryFn: () => getFunnel(applied),
  });
  const byMarketQ = useQuery({
    queryKey: ['candidateAnalytics', 'byMarket', applied.from ?? '', applied.to ?? ''],
    queryFn: () => getByMarket({ from: applied.from, to: applied.to }),
  });
  const bySourceQ = useQuery({
    queryKey: ['candidateAnalytics', 'bySource', applied.from ?? '', applied.to ?? ''],
    queryFn: () => getBySource({ from: applied.from, to: applied.to }),
  });
  const byJobOrderQ = useQuery({
    queryKey: ['candidateAnalytics', 'byJobOrder', applied.from ?? '', applied.to ?? ''],
    queryFn: () => getConversionByJobOrder({ from: applied.from, to: applied.to }),
  });

  function applyFilters() {
    setApplied({
      from: from || undefined,
      to: to || undefined,
      market: market || undefined,
    });
  }

  function resetFilters() {
    setFrom('');
    setTo('');
    setMarket('');
    setApplied({});
  }

  const funnel = funnelQ.data;

  // Build funnel stages (count + % of the funnel top = total candidates).
  const funnelStages: FunnelStage[] = useMemo(() => {
    if (!funnel) return [];
    const total = funnel.total || 0;
    return FUNNEL_ORDER.map((stage) => {
      const count = funnel.counts[stage] ?? 0;
      return {
        label: CANDIDATE_STAGE_LABELS[stage] ?? stage,
        count,
        percentOfTotal: total > 0 ? (count / total) * 100 : 0,
      };
    });
  }, [funnel]);

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">CRM tuyển dụng</div>
          <h1 className="page-title">Phân tích tuyển dụng</h1>
        </div>
        <span className="muted">Phễu ứng viên · chuyển đổi đơn hàng → xuất cảnh</span>
      </div>

      {/* ---- Filters ---- */}
      <div className="card">
        <div className="toolbar">
          <div className="field">
            <label htmlFor="an-from">Từ ngày</label>
            <input id="an-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="an-to">Đến ngày</label>
            <input id="an-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="an-market">Thị trường (phễu)</label>
            <select id="an-market" value={market} onChange={(e) => setMarket(e.target.value)}>
              <option value="">Tất cả</option>
              {MARKETS.map((m) => (
                <option key={m} value={m}>
                  {marketLabel(m)}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn--secondary" onClick={applyFilters}>
            Áp dụng
          </button>
          <button className="btn" onClick={resetFilters}>
            Đặt lại
          </button>
        </div>
        <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          Mẹo: để trống ngày để xem toàn bộ. Tài khoản SALES chỉ thấy ứng viên được phân công.
        </div>
      </div>

      {/* ---- KPI tiles ---- */}
      {funnelQ.isLoading ? (
        <Loading variant="kpi" cols={4} />
      ) : funnelQ.error ? (
        <ErrorMessage error={funnelQ.error} />
      ) : funnel ? (
        <>
          <div className="grid grid-4" style={{ marginBottom: 'var(--space-md)' }}>
            <StatCard label="Tổng ứng viên" count={funnel.total} />
            <StatCard label="Tỉ lệ đã tư vấn" count={funnel.rates.contactedRate} suffix="%" />
            <StatCard label="Tỉ lệ phỏng vấn" count={funnel.rates.interviewRate} suffix="%" />
            <StatCard
              label="Tỉ lệ xuất cảnh"
              count={funnel.rates.departedRate}
              suffix="%"
              valueColor="var(--success-fg)"
            />
          </div>

          <div className="grid grid-2">
            {/* Funnel */}
            <div className="card">
              <h2 className="card-title">Phễu tuyển dụng</h2>
              {funnel.insufficient ? (
                <div className="muted">Chưa đủ dữ liệu trong khoảng đã chọn.</div>
              ) : (
                <FunnelChart stages={funnelStages} />
              )}
            </div>

            {/* Conversion donut */}
            <div className="card">
              <h2 className="card-title">Chuyển đổi xuất cảnh</h2>
              <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-sm) 0' }}>
                <DonutChart
                  percent={funnel.rates.departedRate}
                  caption={`${funnel.counts.DEPARTED ?? 0} / ${funnel.total} ứng viên đã xuất cảnh`}
                />
              </div>
              <div className="muted" style={{ fontSize: 'var(--fs-xs)', textAlign: 'center' }}>
                Tỉ lệ ứng viên đi đến trạng thái “Đã xuất cảnh”.
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* ---- Distribution charts ---- */}
      <div className="grid grid-2">
        <div className="card">
          <h2 className="card-title">Ứng viên theo thị trường</h2>
          {byMarketQ.isLoading ? (
            <Loading label="Đang tải…" />
          ) : byMarketQ.error ? (
            <ErrorMessage error={byMarketQ.error} />
          ) : (
            <BarChart
              data={(byMarketQ.data?.buckets ?? []).map((b) => ({
                label: marketLabel(b.key) === '—' ? b.key || 'Chưa rõ' : marketLabel(b.key),
                value: b.count,
              }))}
            />
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Ứng viên theo nguồn</h2>
          {bySourceQ.isLoading ? (
            <Loading label="Đang tải…" />
          ) : bySourceQ.error ? (
            <ErrorMessage error={bySourceQ.error} />
          ) : (
            <BarChart
              data={(bySourceQ.data?.buckets ?? []).map((b) => ({
                label: b.key || 'Chưa rõ',
                value: b.count,
              }))}
            />
          )}
        </div>
      </div>

      {/* ---- Conversion by job order ---- */}
      <div className="card">
        <h2 className="card-title">Chuyển đổi theo đơn hàng (đơn → xuất cảnh)</h2>
        {byJobOrderQ.isLoading ? (
          <Loading variant="table" rows={5} />
        ) : byJobOrderQ.error ? (
          <ErrorMessage error={byJobOrderQ.error} />
        ) : (byJobOrderQ.data?.buckets ?? []).length === 0 ? (
          <Empty icon="bar-chart-3" label="Chưa có ứng viên nào được ghép đơn trong khoảng này." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Mã đơn hàng</th>
                  <th>Tổng ứng viên</th>
                  <th>Đã xuất cảnh</th>
                  <th>Tỉ lệ xuất cảnh</th>
                </tr>
              </thead>
              <tbody>
                {(byJobOrderQ.data?.buckets ?? [])
                  .slice()
                  .sort((a, b) => b.departedRate - a.departedRate)
                  .map((b) => (
                    <tr key={b.matchedJobOrderId}>
                      <td>
                        <code>{b.matchedJobOrderId.slice(0, 12)}</code>
                      </td>
                      <td>{b.total}</td>
                      <td>{b.departed}</td>
                      <td>
                        <span
                          className={`badge ${b.departedRate >= 50 ? 'badge-green' : b.departedRate > 0 ? 'badge-yellow' : 'badge-gray'}`}
                        >
                          {b.departedRate.toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
