/**
 * Settings / Profile — shows the logged-in user and a logout action, plus the
 * realtime connection status. ADMIN users additionally see an "AI Operations"
 * (AgentOps) card summarising AI text-call telemetry.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../realtime/RealtimeContext';
import { ErrorMessage, Loading, StatusBadge } from '../components/ui';
import { ApiError } from '../lib/apiClient';
import { getAiTelemetry } from '../api/aiTelemetry';
import type { AiTelemetrySummary } from '../api/aiTelemetry';

/**
 * Format a success/error rate. The backend emits rates as a fraction in [0, 1]
 * (e.g. 0.873) or the sentinel string 'INSUFFICIENT_DATA' when no calls have
 * been recorded yet. Render numeric rates as a percentage with one decimal.
 */
function formatRate(value: number | 'INSUFFICIENT_DATA'): string {
  if (value === 'INSUFFICIENT_DATA') return 'Chưa đủ dữ liệu';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format a latency percentile. Numeric values are milliseconds; the sentinel
 * 'INSUFFICIENT_DATA' renders as a friendly Vietnamese placeholder.
 */
function formatMs(value: number | 'INSUFFICIENT_DATA'): string {
  if (value === 'INSUFFICIENT_DATA') return 'Chưa đủ dữ liệu';
  return `${value} ms`;
}

export function Settings() {
  const { user, logout } = useAuth();
  const { status } = useRealtime();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Hệ thống</div>
          <h1 className="page-title">Cài đặt</h1>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 520 }}>
        <h2 className="card-title">Hồ sơ tài khoản</h2>
        <dl className="kv">
          <dt>Mã người dùng</dt>
          <dd>{user?.id}</dd>
          <dt>Tên đăng nhập</dt>
          <dd>{user?.username}</dd>
          <dt>Email</dt>
          <dd>{user?.email}</dd>
          <dt>Vai trò</dt>
          <dd>
            <span className="role-pill">{user?.role}</span>
          </dd>
          <dt>Kết nối thời gian thực</dt>
          <dd>
            <StatusBadge status={status === 'open' ? 'CURRENT' : 'STALE'} />{' '}
            <span className="muted">{status}</span>
          </dd>
        </dl>
        <div className="modal-actions">
          <button className="btn btn-danger" onClick={handleLogout}>
            Đăng xuất
          </button>
        </div>
      </div>

      {user?.role === 'ADMIN' && <AiOperationsCard />}
    </div>
  );
}

/**
 * ADMIN-only AgentOps card. Fetches GET /api/v1/ai/telemetry on mount and on
 * demand (Refresh), surfacing an inline error instead of crashing on failure.
 * Only rendered for ADMIN (the endpoint returns 403 for SALES).
 */
function AiOperationsCard() {
  const [data, setData] = useState<AiTelemetrySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const summary = await getAiTelemetry();
      setData(summary);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err);
      } else {
        setError(new ApiError(0, 'UNKNOWN', err instanceof Error ? err.message : String(err)));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const errorCodes = data ? Object.entries(data.errorCodeCounts) : [];

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-md)',
        }}
      >
        <h2 className="card-title" style={{ marginBottom: 0, paddingBottom: 0, border: 'none' }}>
          AI Operations
        </h2>
        <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Đang tải…' : 'Làm mới'}
        </button>
      </div>
      <p className="muted">Giám sát các lượt gọi AI tạo nội dung (AgentOps).</p>

      {loading ? (
        <Loading label="Đang tải số liệu AI…" />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <dl className="kv">
          <dt>Tổng số lượt gọi</dt>
          <dd>{data.totalCalls}</dd>
          <dt>Thành công</dt>
          <dd>{data.successCount}</dd>
          <dt>Lỗi AI</dt>
          <dd>{data.aiErrorCount}</dd>
          <dt>Lỗi không xác định</dt>
          <dd>{data.unknownErrorCount}</dd>
          <dt>Tỉ lệ thành công</dt>
          <dd>{formatRate(data.successRate)}</dd>
          <dt>Tỉ lệ lỗi</dt>
          <dd>{formatRate(data.errorRate)}</dd>
          <dt>Độ trễ p50</dt>
          <dd>{formatMs(data.p50LatencyMs)}</dd>
          <dt>Độ trễ p95</dt>
          <dd>{formatMs(data.p95LatencyMs)}</dd>
          <dt>Mã lỗi</dt>
          <dd>
            {errorCodes.length === 0 ? (
              '—'
            ) : (
              <ul className="inline-list" style={{ flexDirection: 'column', gap: 'var(--space-xs)' }}>
                {errorCodes.map(([code, count]) => (
                  <li key={code}>
                    <code>{code}</code>: {count}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}
