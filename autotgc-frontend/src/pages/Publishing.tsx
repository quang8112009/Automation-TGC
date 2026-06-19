/**
 * Publishing — schedule an approved draft to platforms, retry a failed
 * scheduled post, and trigger an immediate publish of a scheduled post.
 *
 * Endpoints: POST /api/publishing/schedule, POST /api/publishing/scheduled/:id/retry,
 * POST /api/publishing/post. Publish/retry may surface 502 when the platform
 * adapter token isn't configured — handled cleanly.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { retryScheduledPost, schedulePost, triggerPublish } from '../api/publishing';
import { ErrorMessage, SuccessMessage } from '../components/ui';

const PLATFORMS = ['facebook', 'tiktok', 'website'];

export function Publishing() {
  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Nội dung</div>
          <h1 className="page-title">Đăng bài</h1>
        </div>
      </div>
      <div className="grid grid-2">
        <ScheduleCard />
        <div>
          <RetryCard />
          <PublishNowCard />
        </div>
      </div>
    </div>
  );
}

function ScheduleCard() {
  const [draftId, setDraftId] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [times, setTimes] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const platforms = PLATFORMS.filter((p) => selected[p]);
      const scheduledAt: Record<string, string> = {};
      for (const p of platforms) {
        if (times[p]) scheduledAt[p] = new Date(times[p]).toISOString();
      }
      return schedulePost({ draftId, platforms, scheduledAt });
    },
    onSuccess: (data) => setResult(JSON.stringify(data, null, 2)),
  });

  return (
    <div className="card">
      <h2 className="card-title">Lên lịch đăng bản nháp</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {result && <SuccessMessage>Đã lên lịch.</SuccessMessage>}
      <div className="field">
        <label>Mã bản nháp (bắt buộc)</label>
        <input value={draftId} onChange={(e) => setDraftId(e.target.value)} />
      </div>
      <label>Nền tảng &amp; thời gian</label>
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
          disabled={!draftId || mutation.isPending}
          onClick={() => {
            setResult(null);
            mutation.mutate();
          }}
        >
          {mutation.isPending ? 'Đang lên lịch…' : 'Lên lịch'}
        </button>
      </div>
      {result && <pre className="code">{result}</pre>}
    </div>
  );
}

function RetryCard() {
  const [id, setId] = useState('');
  const [at, setAt] = useState('');
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () => retryScheduledPost(id, new Date(at).toISOString()),
    onSuccess: () => setDone(true),
  });

  return (
    <div className="card">
      <h2 className="card-title">Đăng lại bài lỗi</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {done && <SuccessMessage>Đã lên lịch đăng lại.</SuccessMessage>}
      <div className="field">
        <label>Mã bài đã lên lịch (bắt buộc)</label>
        <input value={id} onChange={(e) => setId(e.target.value)} />
      </div>
      <div className="field">
        <label>Thời gian mới (bắt buộc)</label>
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button
          className="btn btn--secondary"
          disabled={!id || !at || mutation.isPending}
          onClick={() => {
            setDone(false);
            mutation.mutate();
          }}
        >
          {mutation.isPending ? 'Đang xử lý…' : 'Đăng lại'}
        </button>
      </div>
    </div>
  );
}

function PublishNowCard() {
  const [id, setId] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => triggerPublish(id),
    onSuccess: (data) => setResult(JSON.stringify(data, null, 2)),
  });

  return (
    <div className="card">
      <h2 className="card-title">Đăng ngay</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {result && <SuccessMessage>Đã đăng.</SuccessMessage>}
      <div className="field">
        <label>Mã bài đã lên lịch (bắt buộc)</label>
        <input value={id} onChange={(e) => setId(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button
          className="btn btn--secondary"
          disabled={!id || mutation.isPending}
          onClick={() => {
            setResult(null);
            mutation.mutate();
          }}
        >
          {mutation.isPending ? 'Đang đăng…' : 'Đăng ngay'}
        </button>
      </div>
      {result && <pre className="code">{result}</pre>}
    </div>
  );
}
