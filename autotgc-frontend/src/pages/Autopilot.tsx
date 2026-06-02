/**
 * Autopilot (/autopilot, ADMIN) — the flagship AI MARKETING AUTOPILOT page for
 * Thanh Giang (XKLĐ). Start a run (market, objective, period, channels,
 * requireApproval), then watch the saga progress as a timeline:
 *
 *   research → plan → generate → review_gate → schedule → summary
 *
 * The run PAUSES at `review_gate` (status WAITING_APPROVAL): the UI shows this
 * and offers "Phê duyệt & tiếp tục" (approve) + "Hủy" (cancel). We poll the run
 * while it is RUNNING/PENDING (and refresh on realtime 'workflow' events), then
 * stop on a terminal status and show the final summary (generated / scheduled /
 * skipped counts).
 *
 * Endpoints: POST /api/v1/autopilot/run, GET /api/v1/autopilot/runs/:id,
 * POST .../approve, POST .../cancel.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveAutopilotRun,
  cancelAutopilotRun,
  getAutopilotRun,
  startAutopilot,
} from '../api/autopilot';
import { useRealtime } from '../realtime/RealtimeContext';
import { ErrorMessage, Loading, StatusBadge, SuccessMessage, formatDate } from '../components/ui';
import {
  AUTOPILOT_STEP_LABELS,
  AUTOPILOT_STEP_ORDER,
  MARKETING_CHANNELS,
  MARKETING_CHANNEL_LABELS,
  MARKETING_MARKETS,
  MARKETING_MARKET_LABELS,
  MARKETING_OBJECTIVES,
  MARKETING_OBJECTIVE_LABELS,
  SCHEDULABLE_CHANNELS,
  TERMINAL_RUN_STATUSES,
  autopilotStepLabel,
  marketingMarketLabel,
} from '../lib/marketing';
import type { AutopilotSummary, WorkflowRun, WorkflowStep } from '../lib/types';

export function Autopilot() {
  const [runId, setRunId] = useState<string | null>(null);

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Marketing AI</div>
          <h1 className="page-title">Autopilot</h1>
        </div>
      </div>

      <div className="muted" style={{ marginBottom: 16, maxWidth: 760 }}>
        Vòng lặp tự động hóa marketing: nghiên cứu xu hướng → lập kế hoạch → tạo nội dung & tài sản →
        cổng phê duyệt (con người) → lên lịch đăng → tổng kết. Theo nguyên tắc “chất lượng hơn số
        lượng”, run sẽ dừng tại cổng phê duyệt để con người duyệt nội dung trước khi lên lịch.
      </div>

      <StartAutopilotCard onStarted={setRunId} />

      {runId && <RunTimeline runId={runId} />}
    </div>
  );
}

function StartAutopilotCard({ onStarted }: { onStarted: (id: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [market, setMarket] = useState('JAPAN');
  const [objective, setObjective] = useState('Lead');
  const [periodFrom, setPeriodFrom] = useState(today);
  const [periodTo, setPeriodTo] = useState(today);
  const [channels, setChannels] = useState<Record<string, boolean>>({});
  const [requireApproval, setRequireApproval] = useState(true);
  const [domainName, setDomainName] = useState('');
  const [personaIds, setPersonaIds] = useState('');

  const mutation = useMutation({
    mutationFn: () => {
      const selected = MARKETING_CHANNELS.filter((c) => channels[c]);
      const personas = personaIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return startAutopilot({
        market,
        objective,
        periodFrom: new Date(periodFrom).toISOString(),
        periodTo: new Date(periodTo).toISOString(),
        channels: selected.length > 0 ? selected : undefined,
        requireApproval,
        domainName: domainName.trim() || undefined,
        personaIds: personas.length > 0 ? personas : undefined,
      });
    },
    onSuccess: (res) => onStarted(res.runId),
  });

  return (
    <div className="card">
      <h2 className="card-title">Khởi động Autopilot</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {mutation.data && <SuccessMessage>Đã khởi động run {mutation.data.runId}</SuccessMessage>}

      <div className="grid grid-2">
        <div className="field">
          <label>Thị trường *</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            {MARKETING_MARKETS.map((m) => (
              <option key={m} value={m}>
                {MARKETING_MARKET_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Mục tiêu *</label>
          <select value={objective} onChange={(e) => setObjective(e.target.value)}>
            {MARKETING_OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {MARKETING_OBJECTIVE_LABELS[o]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Từ ngày *</label>
          <input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>Đến ngày *</label>
          <input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
        </div>
        <div className="field">
          <label>Domain (tùy chọn)</label>
          <input
            value={domainName}
            onChange={(e) => setDomainName(e.target.value)}
            placeholder="VD: thanhgiang.com.vn"
          />
        </div>
        <div className="field">
          <label>Persona IDs (tùy chọn, phân tách bằng dấu phẩy)</label>
          <input value={personaIds} onChange={(e) => setPersonaIds(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>Kênh phân phối (bỏ trống = tất cả kênh)</label>
        <div className="inline-list">
          {MARKETING_CHANNELS.map((c) => (
            <label
              key={c}
              style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, minWidth: 130 }}
            >
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={!!channels[c]}
                onChange={(e) => setChannels((s) => ({ ...s, [c]: e.target.checked }))}
              />
              {MARKETING_CHANNEL_LABELS[c]}
              {!SCHEDULABLE_CHANNELS.has(c) && (
                <span className="muted" style={{ fontSize: 11 }} title="Được tạo nội dung nhưng chưa lên lịch tự động">
                  (chỉ tạo)
                </span>
              )}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={requireApproval}
            onChange={(e) => setRequireApproval(e.target.checked)}
          />
          Yêu cầu phê duyệt của con người trước khi lên lịch (khuyến nghị)
        </label>
      </div>

      <button className="btn btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Đang khởi động…' : 'Khởi động Autopilot'}
      </button>
    </div>
  );
}

function RunTimeline({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const { subscribe } = useRealtime();
  const [actionError, setActionError] = useState<unknown>(null);

  const runQuery = useQuery({
    queryKey: ['autopilotRun', runId],
    queryFn: () => getAutopilotRun(runId),
    // Poll while the run is active; stop on a terminal status.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_RUN_STATUSES.has(status)) return false;
      return 2500;
    },
  });

  // Refresh on realtime 'workflow' events for this run (polling still backs us up).
  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.topic !== 'workflow') return;
      const payload = event.payload as Record<string, unknown> | null;
      if (payload && payload.runId && payload.runId !== runId) return;
      void queryClient.invalidateQueries({ queryKey: ['autopilotRun', runId] });
    });
    return unsubscribe;
  }, [subscribe, queryClient, runId]);

  const approveMutation = useMutation({
    mutationFn: () => approveAutopilotRun(runId),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['autopilotRun', runId] });
    },
    onError: (err) => setActionError(err),
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelAutopilotRun(runId),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['autopilotRun', runId] });
    },
    onError: (err) => setActionError(err),
  });

  if (runQuery.isLoading) {
    return (
      <div className="card">
        <Loading label="Đang tải run…" />
      </div>
    );
  }
  if (runQuery.error) {
    return (
      <div className="card">
        <ErrorMessage error={runQuery.error} />
      </div>
    );
  }
  const run = runQuery.data;
  if (!run) return null;

  const awaitingApproval = run.status === 'WAITING_APPROVAL';
  const isTerminal = TERMINAL_RUN_STATUSES.has(run.status);
  const summary = extractSummary(run);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          Run {run.id}
        </h2>
        <StatusBadge status={run.status} />
        {!isTerminal && <span className="muted">đang theo dõi…</span>}
      </div>

      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Bước hiện tại</dt>
        <dd>{run.currentStep ? autopilotStepLabel(run.currentStep) : '—'}</dd>
        <dt>Tạo lúc</dt>
        <dd>{formatDate(run.createdAt)}</dd>
        {run.error && (
          <>
            <dt>Lỗi</dt>
            <dd>{run.error}</dd>
          </>
        )}
      </dl>

      {actionError != null && <ErrorMessage error={actionError} />}

      {awaitingApproval && (
        <div className="notice" style={{ marginTop: 12 }}>
          <strong>Đang chờ phê duyệt.</strong> Run đã tạo xong nội dung và dừng tại cổng phê duyệt.
          Hãy duyệt nội dung trước khi hệ thống lên lịch đăng.
          <div className="row-actions" style={{ marginTop: 10 }}>
            <button
              className="btn btn--secondary"
              disabled={approveMutation.isPending}
              onClick={() => approveMutation.mutate()}
            >
              {approveMutation.isPending ? 'Đang duyệt…' : 'Phê duyệt & tiếp tục'}
            </button>
            <button
              className="btn btn-danger"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              Hủy
            </button>
          </div>
        </div>
      )}

      {!awaitingApproval && !isTerminal && (
        <div className="row-actions" style={{ margin: '12px 0' }}>
          <button
            className="btn btn-danger"
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
          >
            Hủy run
          </button>
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>Tiến trình</h3>
      <StepTimeline run={run} />

      {summary && (
        <>
          <h3 style={{ marginTop: 16 }}>Tổng kết</h3>
          <div className="grid grid-4">
            <div className="stat">
              <div className="stat-label">Đã tạo</div>
              <div className="stat-value">{summary.generated}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Đã lên lịch</div>
              <div className="stat-value">{summary.scheduled}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Bỏ qua</div>
              <div className="stat-value">{summary.skipped}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Thị trường</div>
              <div className="stat-value" style={{ fontSize: 18 }}>
                {marketingMarketLabel(summary.market)}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Render the canonical autopilot steps as a timeline, ordered consistently. */
function StepTimeline({ run }: { run: WorkflowRun }) {
  // Order steps by the canonical order, then by orderIndex for any extras.
  const byName = new Map(run.steps.map((s) => [s.name, s]));
  const ordered: WorkflowStep[] = [];
  for (const name of AUTOPILOT_STEP_ORDER) {
    const step = byName.get(name);
    if (step) {
      ordered.push(step);
      byName.delete(name);
    }
  }
  // Append any steps not in the canonical list (defensive).
  const extras = [...byName.values()].sort((a, b) => a.orderIndex - b.orderIndex);
  const allSteps = [...ordered, ...extras];

  return (
    <div className="steps-list">
      {allSteps.map((s, i) => (
        <div key={s.id} className="step-row" style={{ alignItems: 'flex-start' }}>
          <span className="step-index">{i + 1}</span>
          <div style={{ flex: 1 }}>
            <strong>{AUTOPILOT_STEP_LABELS[s.name] ?? s.name}</strong>
            {s.name === 'review_gate' && (
              <div className="muted" style={{ fontSize: 12 }}>
                Cổng phê duyệt của con người
              </div>
            )}
            <StepOutput output={s.output} />
            {s.error && <div className="muted">Lỗi: {s.error}</div>}
          </div>
          <StatusBadge status={s.status} />
        </div>
      ))}
    </div>
  );
}

/** Compactly summarize a step's output (best-effort; tolerant of any shape). */
function StepOutput({ output }: { output: unknown }) {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  const parts: string[] = [];

  const push = (key: string, label: string) => {
    if (typeof o[key] === 'number') parts.push(`${label}: ${o[key] as number}`);
  };
  push('trendsCount', 'Số xu hướng');
  push('itemCount', 'Số mục');
  push('generated', 'Đã tạo');
  push('skipped', 'Bỏ qua');
  push('scheduled', 'Đã lên lịch');
  push('skippedUnapproved', 'Chưa duyệt');
  push('skippedChannel', 'Kênh chưa hỗ trợ');
  push('skippedRejected', 'Từ chối');
  if (typeof o.researched === 'boolean') {
    parts.push(o.researched ? 'Đã nghiên cứu mới' : 'Dùng xu hướng sẵn có');
  }
  if (typeof o.planId === 'string') parts.push('Đã tạo kế hoạch');

  if (parts.length === 0) return null;
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
      {parts.join(' · ')}
    </div>
  );
}

/** Pull the summary object out of the run context or the summary step output. */
function extractSummary(run: WorkflowRun): AutopilotSummary | null {
  // Prefer the summary step's output.summary.
  const summaryStep = run.steps.find((s) => s.name === 'summary');
  const fromStep = readSummary(summaryStep?.output);
  if (fromStep) return fromStep;
  // Fallback: the run context may carry a merged summary.
  return readSummary(run.context);
}

function readSummary(value: unknown): AutopilotSummary | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const s = (o.summary ?? o) as Record<string, unknown>;
  if (typeof s.generated !== 'number' && typeof s.scheduled !== 'number') return null;
  return {
    market: typeof s.market === 'string' ? s.market : null,
    planId: typeof s.planId === 'string' ? s.planId : null,
    generated: typeof s.generated === 'number' ? s.generated : 0,
    scheduled: typeof s.scheduled === 'number' ? s.scheduled : 0,
    skipped: typeof s.skipped === 'number' ? s.skipped : 0,
  };
}
