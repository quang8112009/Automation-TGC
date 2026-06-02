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
          <h1 className="page-title">Publishing</h1>
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
      <h2 className="card-title">Schedule a Draft</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {result && <SuccessMessage>Scheduled.</SuccessMessage>}
      <div className="field">
        <label>Draft ID *</label>
        <input value={draftId} onChange={(e) => setDraftId(e.target.value)} />
      </div>
      <label>Platforms &amp; times</label>
      {PLATFORMS.map((p) => (
        <div
          key={p}
          style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}
        >
          <label style={{ margin: 0, minWidth: 90 }}>
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 6 }}
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
          {mutation.isPending ? 'Scheduling…' : 'Schedule'}
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
      <h2 className="card-title">Retry Failed Post</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {done && <SuccessMessage>Retry scheduled.</SuccessMessage>}
      <div className="field">
        <label>Scheduled Post ID *</label>
        <input value={id} onChange={(e) => setId(e.target.value)} />
      </div>
      <div className="field">
        <label>New time *</label>
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
          {mutation.isPending ? 'Retrying…' : 'Retry'}
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
      <h2 className="card-title">Trigger Publish</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      <div className="field">
        <label>Scheduled Post ID *</label>
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
          {mutation.isPending ? 'Publishing…' : 'Publish now'}
        </button>
      </div>
      {result && <pre className="code">{result}</pre>}
    </div>
  );
}
