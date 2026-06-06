/**
 * Workflows (Agentic Orchestration) — start a content-pipeline run, then poll a
 * run and its steps, with resume (after approval gate) and cancel. Realtime
 * 'workflow' events also invalidate the polled query for snappier updates.
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
  StatusBadge,
  SuccessMessage,
  formatDate,
} from '../components/ui';
import { PersonaPicker } from '../components/PersonaPicker';

const PLATFORMS = ['facebook', 'tiktok', 'website'];

export function Workflows() {
  const [runId, setRunId] = useState<string | null>(null);

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Marketing AI</div>
          <h1 className="page-title">Workflows</h1>
        </div>
      </div>

      <div className="grid grid-2">
        <StartWorkflowCard onStarted={setRunId} />
        <TrackRunCard runId={runId} onTrack={setRunId} />
      </div>

      {runId && <RunDetail runId={runId} />}
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
      <h2 className="card-title">Start Content Pipeline</h2>
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {mutation.data && <SuccessMessage>Started run {mutation.data.runId}</SuccessMessage>}
      <div className="field">
        <label>Domain name *</label>
        <input value={domainName} onChange={(e) => setDomainName(e.target.value)} />
      </div>
      <div className="field">
        <label>Persona IDs (comma-separated)</label>
        <input value={personaIds} onChange={(e) => setPersonaIds(e.target.value)} />
        <PersonaPicker value={personaIds} onChange={setPersonaIds} />
      </div>
      <div className="field">
        <label>Objective</label>
        <input value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <label>Platforms &amp; times (optional)</label>
      {PLATFORMS.map((p) => (
        <div key={p} style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
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
          {mutation.isPending ? 'Starting…' : 'Start run'}
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
      <h2 className="card-title">Track a Run</h2>
      <div className="field">
        <label>Run ID</label>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={runId ?? 'paste a run id'}
        />
      </div>
      <div className="modal-actions">
        <button className="btn btn--secondary" disabled={!input} onClick={() => onTrack(input)}>
          Track
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
    // Poll while the run is active; stop when terminal.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) return false;
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
      <h2 className="card-title">Run {runId}</h2>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          {(resumeMutation.error ?? cancelMutation.error) != null && (
            <ErrorMessage error={resumeMutation.error ?? cancelMutation.error} />
          )}
          {resumeMutation.isSuccess && <SuccessMessage>Resumed run after approval gate.</SuccessMessage>}
          {cancelMutation.isSuccess && <SuccessMessage>Run cancelled.</SuccessMessage>}
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Current step</dt>
            <dd>{data.currentStep ?? '—'}</dd>
            <dt>Type</dt>
            <dd>{data.type}</dd>
            <dt>Created</dt>
            <dd>{formatDate(data.createdAt)}</dd>
            {data.error && (
              <>
                <dt>Error</dt>
                <dd>{data.error}</dd>
              </>
            )}
          </dl>

          <div className="row-actions" style={{ margin: 'var(--space-md) 0' }}>
            <button
              className="btn"
              disabled={data.status !== 'WAITING_APPROVAL' || resumeMutation.isPending}
              onClick={() => resumeMutation.mutate()}
            >
              Resume
            </button>
            <button
              className="btn btn-danger"
              disabled={
                ['COMPLETED', 'FAILED', 'CANCELLED'].includes(data.status) ||
                cancelMutation.isPending
              }
              onClick={() => cancelMutation.mutate()}
            >
              Cancel
            </button>
          </div>

          <h3>Steps</h3>
          <div className="steps-list">
            {data.steps.map((s) => (
              <div key={s.id} className="step-row">
                <span className="step-index">{s.orderIndex + 1}</span>
                <div style={{ flex: 1 }}>
                  <strong>{s.name}</strong>
                  {s.error && <div className="muted">Error: {s.error}</div>}
                </div>
                <StatusBadge status={s.status} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
