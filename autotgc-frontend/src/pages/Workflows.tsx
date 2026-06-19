/**
 * Quy trình tự động (Agentic Orchestration) — màn hình giải thích & vận hành
 * "dây chuyền tạo nội dung": AI viết nháp → AI biên tập → người duyệt → lên lịch.
 *
 * Người dùng: bấm "Bắt đầu quy trình", điền thông tin, hệ thống chạy tự động và
 * DỪNG ở bước "Chờ duyệt". Quản trị xem nháp rồi bấm "Duyệt & tiếp tục" để chạy
 * nốt bước lên lịch, hoặc "Huỷ quy trình".
 *
 * Endpoints: POST /api/v1/workflows, GET /api/v1/workflows/:id,
 * POST /api/v1/workflows/:id/resume, POST /api/v1/workflows/:id/cancel.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelWorkflow,
  getWorkflow,
  resumeWorkflow,
  startWorkflow,
} from '../api/workflows';
import {
  ErrorMessage,
  Loading,
  SuccessMessage,
  formatDate,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { PersonaPicker } from '../components/PersonaPicker';

const PLATFORMS = ['facebook', 'tiktok', 'website'];

/**
 * Bốn bước của dây chuyền (khớp với backend buildContentPipelineWorkflow):
 *  generate_content → review_content → await_review → schedule.
 * Map theo tên bước để hiển thị nhãn tiếng Việt + mô tả dễ hiểu.
 */
const STEP_INFO: Record<string, { label: string; desc: string }> = {
  generate_content: {
    label: 'AI viết bản nháp',
    desc: 'Trợ lý AI tạo tiêu đề + nội dung + lời kêu gọi dựa trên lĩnh vực và persona bạn chọn.',
  },
  review_content: {
    label: 'AI biên tập & chấm điểm',
    desc: 'AI rà lại bản nháp, góp ý và cho điểm chất lượng trước khi đưa người duyệt.',
  },
  await_review: {
    label: 'Chờ người duyệt',
    desc: 'Quy trình DỪNG tại đây để con người kiểm tra. Bấm “Duyệt & tiếp tục” để chạy nốt.',
  },
  schedule: {
    label: 'Lên lịch đăng',
    desc: 'Sau khi được duyệt, bài được đưa vào hàng đợi đăng theo nền tảng và thời gian đã chọn.',
  },
};

/** Nhãn tiếng Việt + màu badge cho trạng thái cả quy trình lẫn từng bước. */
const STATUS_INFO: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Chờ chạy', cls: 'badge-gray' },
  RUNNING: { label: 'Đang chạy', cls: 'badge-blue' },
  WAITING_APPROVAL: { label: 'Chờ duyệt', cls: 'badge-yellow' },
  COMPLETED: { label: 'Hoàn tất', cls: 'badge-green' },
  FAILED: { label: 'Lỗi', cls: 'badge-red' },
  CANCELLED: { label: 'Đã huỷ', cls: 'badge-gray' },
  // step-only
  DONE: { label: 'Xong', cls: 'badge-green' },
  SKIPPED: { label: 'Bỏ qua', cls: 'badge-gray' },
  IN_PROGRESS: { label: 'Đang làm', cls: 'badge-blue' },
};

function statusLabel(status: string): { label: string; cls: string } {
  return STATUS_INFO[status] ?? { label: status, cls: 'badge-gray' };
}

/** Badge trạng thái dùng nhãn tiếng Việt. */
function VnStatusBadge({ status }: { status: string }) {
  const { label, cls } = statusLabel(status);
  return <span className={`badge ${cls}`}>{label}</span>;
}

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function Workflows() {
  const [runId, setRunId] = useState<string | null>(null);

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Marketing AI</div>
          <h1 className="page-title">Quy trình tự động</h1>
        </div>
        <span className="muted">Dây chuyền: AI viết → AI biên tập → người duyệt → lên lịch</span>
      </div>

      <HowItWorks />

      <div className="grid grid-2">
        <StartWorkflowCard onStarted={setRunId} />
        <TrackRunCard runId={runId} onTrack={setRunId} />
      </div>

      {runId && <RunDetail runId={runId} />}
    </div>
  );
}

/** Bảng giải thích quy trình hoạt động ra sao — 4 bước, đọc là hiểu. */
function HowItWorks() {
  const order = ['generate_content', 'review_content', 'await_review', 'schedule'];
  return (
    <div className="card">
      <h2 className="card-title">Quy trình này làm gì?</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Đây là “dây chuyền” tạo một bài nội dung tự động. Bạn chỉ cần bấm bắt đầu và điền thông
        tin; hệ thống chạy lần lượt 4 bước dưới đây và tự dừng lại ở bước “Chờ người duyệt” để
        bạn kiểm tra trước khi đăng.
      </p>
      <ol className="how-steps">
        {order.map((key, i) => {
          const info = STEP_INFO[key];
          if (!info) return null;
          return (
            <li key={key} className="how-step">
              <span className="step-index">{i + 1}</span>
              <div>
                <strong>{info.label}</strong>
                <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{info.desc}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StartWorkflowCard({ onStarted }: { onStarted: (id: string) => void }) {
  const [domainName, setDomainName] = useState('');
  const [personaIds, setPersonaIds] = useState('');
  const [objective, setObjective] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [times, setTimes] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const platforms = PLATFORMS.filter((p) => selected[p]);
      const scheduledAt: Record<string, string> = {};
      for (const p of platforms) {
        if (times[p]) scheduledAt[p] = new Date(times[p]).toISOString();
      }
      return startWorkflow({
        domainName,
        personaIds: personaIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        objective: objective || undefined,
        platforms: platforms.length ? platforms : undefined,
        scheduledAt: Object.keys(scheduledAt).length ? scheduledAt : undefined,
      });
    },
    onSuccess: (res) => onStarted(res.runId),
  });

  return (
    <div className="card">
      <h2 className="card-title">Bắt đầu quy trình mới</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 'var(--fs-xs)' }}>
        Điền lĩnh vực và persona để AI viết đúng hướng. Chọn nền tảng + thời gian nếu muốn hệ
        thống lên lịch đăng sau khi bạn duyệt (có thể bỏ trống).
      </p>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {mutation.data && (
        <SuccessMessage>
          Đã bắt đầu quy trình. Mã theo dõi: {mutation.data.runId}
        </SuccessMessage>
      )}
      <div className="field">
        <label>Lĩnh vực / ngành (bắt buộc)</label>
        <input
          value={domainName}
          onChange={(e) => setDomainName(e.target.value)}
          placeholder="VD: Xuất khẩu lao động Nhật Bản"
        />
      </div>
      <div className="field">
        <label>Persona (đối tượng mục tiêu)</label>
        <PersonaPicker value={personaIds} onChange={setPersonaIds} />
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          Chọn từ danh sách; có thể chọn nhiều persona.
        </span>
      </div>
      <div className="field">
        <label>Mục tiêu bài viết (tuỳ chọn)</label>
        <input
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="VD: thu hút ứng viên đăng ký tư vấn"
        />
      </div>
      <label>Đăng lên nền tảng &amp; thời gian (tuỳ chọn)</label>
      {PLATFORMS.map((p) => (
        <div
          key={p}
          style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', marginBottom: 'var(--space-sm)' }}
        >
          <label style={{ margin: 0, minWidth: 90 }}>
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 'var(--space-xs)' }}
              checked={!!selected[p]}
              onChange={(e) => setSelected((s) => ({ ...s, [p]: e.target.checked }))}
            />
            {p}
          </label>
          <input
            type="datetime-local"
            disabled={!selected[p]}
            value={times[p] ?? ''}
            onChange={(e) => setTimes((t) => ({ ...t, [p]: e.target.value }))}
          />
        </div>
      ))}
      <div className="modal-actions">
        <button
          className="btn btn-primary"
          disabled={!domainName || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Đang bắt đầu…' : 'Bắt đầu quy trình'}
        </button>
      </div>
    </div>
  );
}

function TrackRunCard({
  runId,
  onTrack,
}: {
  runId: string | null;
  onTrack: (id: string) => void;
}) {
  const [input, setInput] = useState('');
  return (
    <div className="card">
      <h2 className="card-title">Theo dõi một quy trình</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 'var(--fs-xs)' }}>
        Dán mã theo dõi (nhận được khi bắt đầu) để xem tiến độ các bước theo thời gian thực.
      </p>
      <div className="field">
        <label>Mã theo dõi</label>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={runId ?? 'dán mã theo dõi vào đây'}
        />
      </div>
      <div className="modal-actions">
        <button className="btn btn--secondary" disabled={!input} onClick={() => onTrack(input)}>
          Xem tiến độ
        </button>
      </div>
    </div>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['workflow', runId],
    queryFn: () => getWorkflow(runId),
    // Tự làm mới khi quy trình còn đang chạy; dừng khi đã kết thúc.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL.includes(status)) return false;
      return 3000;
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => resumeWorkflow(runId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workflow', runId] }),
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelWorkflow(runId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workflow', runId] }),
  });

  return (
    <div className="card">
      <h2 className="card-title">Tiến độ quy trình</h2>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          {(resumeMutation.error ?? cancelMutation.error) != null && (
            <ErrorMessage error={resumeMutation.error ?? cancelMutation.error} />
          )}
          {resumeMutation.isSuccess && (
            <SuccessMessage>Đã duyệt — quy trình tiếp tục chạy bước còn lại.</SuccessMessage>
          )}
          {cancelMutation.isSuccess && <SuccessMessage>Đã huỷ quy trình.</SuccessMessage>}

          {/* Trạng thái tổng + đang chờ điều gì */}
          {data.status === 'WAITING_APPROVAL' && (
            <div className="notice" style={{ marginBottom: 'var(--space-md)' }}>
              <strong>Đang chờ bạn duyệt.</strong> AI đã viết xong bản nháp. Hãy kiểm tra rồi bấm
              <em> “Duyệt &amp; tiếp tục” </em> để hệ thống lên lịch đăng, hoặc <em>“Huỷ quy trình”</em>.
            </div>
          )}

          <dl className="kv">
            <dt>Trạng thái</dt>
            <dd><VnStatusBadge status={data.status} /></dd>
            <dt>Bước hiện tại</dt>
            <dd>{data.currentStep ? (STEP_INFO[data.currentStep]?.label ?? data.currentStep) : '—'}</dd>
            <dt>Loại quy trình</dt>
            <dd>{data.type === 'content_pipeline' ? 'Dây chuyền tạo nội dung' : data.type}</dd>
            <dt>Bắt đầu lúc</dt>
            <dd>{formatDate(data.createdAt)}</dd>
            <dt>Mã theo dõi</dt>
            <dd><code>{runId}</code></dd>
            {data.error && (
              <>
                <dt>Lỗi</dt>
                <dd className="muted">{data.error}</dd>
              </>
            )}
          </dl>

          <div className="row-actions" style={{ margin: 'var(--space-md) 0' }}>
            <button
              className="btn btn-primary"
              disabled={data.status !== 'WAITING_APPROVAL' || resumeMutation.isPending}
              onClick={() => resumeMutation.mutate()}
              title={
                data.status === 'WAITING_APPROVAL'
                  ? 'Duyệt bản nháp và chạy nốt bước lên lịch'
                  : 'Chỉ bấm được khi quy trình đang chờ duyệt'
              }
            >
              <Icon name="check" size={16} />
              <span>{resumeMutation.isPending ? 'Đang xử lý…' : 'Duyệt & tiếp tục'}</span>
            </button>
            <button
              className="btn btn-danger"
              disabled={TERMINAL.includes(data.status) || cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              <Icon name="x" size={16} />
              <span>{cancelMutation.isPending ? 'Đang huỷ…' : 'Huỷ quy trình'}</span>
            </button>
          </div>

          <h3>Các bước</h3>
          <div className="steps-list">
            {(data.steps ?? []).map((s) => {
              const info = STEP_INFO[s.name];
              const isCurrent = data.currentStep === s.name && !TERMINAL.includes(data.status);
              return (
                <div key={s.id} className={`step-row${isCurrent ? ' step-row--current' : ''}`}>
                  <span className="step-index">{s.orderIndex + 1}</span>
                  <div style={{ flex: 1 }}>
                    <strong>{info?.label ?? s.name}</strong>
                    {info && (
                      <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{info.desc}</div>
                    )}
                    {s.error && <div className="muted">Lỗi: {s.error}</div>}
                  </div>
                  <VnStatusBadge status={s.status} />
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
