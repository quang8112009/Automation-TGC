/**
 * Insights (Feedback Loop) — ADMIN only. Lists PENDING_REVIEW insights, opens a
 * detail view with supporting performance records, and allows apply/reject/
 * modify. Also exposes the analyze trigger (may 502 when AI not configured).
 *
 * Endpoints: GET /api/feedback/insights, GET /api/feedback/insights/:id,
 * POST /api/feedback/insights/:id/apply|reject|modify, POST /api/feedback/analyze.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyInsight,
  getInsight,
  listInsights,
  modifyInsight,
  rejectInsight,
  runAnalyze,
} from '../api/feedback';
import {
  Empty,
  ErrorMessage,
  Loading,
  Modal,
  Pagination,
  StatusBadge,
  SuccessMessage,
  formatDate,
} from '../components/ui';

export function Insights() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [analyzeMsg, setAnalyzeMsg] = useState<string | null>(null);

  const insightsQuery = useQuery({
    queryKey: ['insights', page],
    queryFn: () => listInsights(page, 20),
  });

  const analyzeMutation = useMutation({
    mutationFn: runAnalyze,
    onSuccess: () => {
      setAnalyzeMsg('Analysis run complete.');
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
    },
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['insights'] });
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">Marketing AI</div>
          <h1 className="page-title">Insights</h1>
        </div>
        <button
          className="btn btn-sm"
          disabled={analyzeMutation.isPending}
          onClick={() => {
            setAnalyzeMsg(null);
            analyzeMutation.mutate();
          }}
        >
          {analyzeMutation.isPending ? 'Analyzing…' : 'Run Analysis'}
        </button>
      </div>

      {analyzeMsg && <SuccessMessage>{analyzeMsg}</SuccessMessage>}
      {analyzeMutation.error != null && <ErrorMessage error={analyzeMutation.error} />}

      <div className="card">
        <h2 className="card-title">Pending Review</h2>
        {insightsQuery.isLoading ? (
          <Loading variant="table" rows={6} label="Đang tải insight…" />
        ) : insightsQuery.error ? (
          <ErrorMessage error={insightsQuery.error} />
        ) : insightsQuery.data && insightsQuery.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Confidence</th>
                    <th>Sample</th>
                    <th>Generated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {insightsQuery.data.items.map((i) => (
                    <tr key={i.insightId}>
                      <td>{i.insightType}</td>
                      <td>
                        <StatusBadge status={i.insightStatus} />
                      </td>
                      <td>{(i.confidenceScore * 100).toFixed(0)}%</td>
                      <td>{i.sampleSize}</td>
                      <td>{formatDate(i.generatedAt)}</td>
                      <td>
                        <button className="btn btn-sm" onClick={() => setOpenId(i.insightId)}>
                          Review
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              limit={20}
              total={insightsQuery.data.total}
              onPage={setPage}
            />
          </>
        ) : (
          <Empty
            icon="lightbulb"
            label="No insights pending review."
            action={
              <button
                className="btn btn-primary btn-sm"
                disabled={analyzeMutation.isPending}
                onClick={() => {
                  setAnalyzeMsg(null);
                  analyzeMutation.mutate();
                }}
              >
                {analyzeMutation.isPending ? 'Analyzing…' : 'Run Analysis'}
              </button>
            }
          />
        )}
      </div>

      {openId && (
        <InsightDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            refresh();
          }}
        />
      )}
    </div>
  );
}

function InsightDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['insights', 'detail', id],
    queryFn: () => getInsight(id),
  });

  const [reason, setReason] = useState('');
  const [modifyText, setModifyText] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const applyMutation = useMutation({
    mutationFn: () => applyInsight(id),
    onSuccess: () => {
      setMessage('Insight applied to strategy.');
      onChanged();
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => rejectInsight(id, reason),
    onSuccess: () => {
      setMessage('Insight rejected.');
      onChanged();
    },
  });

  const modifyMutation = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(modifyText) as Record<string, unknown>;
      } catch {
        throw new Error('Modified change must be valid JSON.');
      }
      return modifyInsight(id, parsed);
    },
    onSuccess: () => {
      setMessage('Modified change saved.');
      onChanged();
    },
  });

  const anyError = applyMutation.error ?? rejectMutation.error ?? modifyMutation.error;

  return (
    <Modal title="Insight Review" onClose={onClose}>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorMessage error={error} />
      ) : data ? (
        <>
          {message && <SuccessMessage>{message}</SuccessMessage>}
          {anyError != null && <ErrorMessage error={anyError} />}

          <dl className="kv">
            <dt>Type</dt>
            <dd>{data.insight.insightType}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.insight.insightStatus} />
            </dd>
            <dt>Confidence</dt>
            <dd>{(data.insight.confidenceScore * 100).toFixed(0)}%</dd>
            <dt>Sample size</dt>
            <dd>{data.insight.sampleSize}</dd>
            <dt>Analysis period</dt>
            <dd>{data.insight.analysisPeriod}</dd>
          </dl>

          <h3>Subject</h3>
          <pre className="code">{JSON.stringify(data.insight.subject, null, 2)}</pre>
          <h3>Recommended Change</h3>
          <pre className="code">{JSON.stringify(data.insight.recommendedChange, null, 2)}</pre>

          <h3>Supporting Records ({data.supportingRecords.length})</h3>
          {data.supportingRecords.length === 0 ? (
            <Empty icon="file-text" label="No supporting records." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Post</th>
                    <th>Topic</th>
                    <th>Label</th>
                    <th>Conv. rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.supportingRecords.map((r) => (
                    <tr key={r.postId}>
                      <td>{r.postId}</td>
                      <td>{r.contentTopic}</td>
                      <td>{r.performanceLabel}</td>
                      <td>{(r.conversionRate * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="field" style={{ marginTop: 'var(--space-md)' }}>
            <label>Modify recommended change (JSON, optional)</label>
            <textarea
              value={modifyText}
              onChange={(e) => setModifyText(e.target.value)}
              placeholder={JSON.stringify(data.insight.recommendedChange)}
            />
            <button
              className="btn btn-sm"
              style={{ marginTop: 'var(--space-xs)' }}
              disabled={!modifyText || modifyMutation.isPending}
              onClick={() => modifyMutation.mutate()}
            >
              Save modification
            </button>
          </div>

          <div className="field">
            <label>Rejection reason</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>

          <div className="modal-actions">
            <button
              className="btn"
              disabled={!reason || rejectMutation.isPending}
              onClick={() => rejectMutation.mutate()}
            >
              Reject
            </button>
            <button
              className="btn btn-primary"
              disabled={applyMutation.isPending}
              onClick={() => applyMutation.mutate()}
            >
              {applyMutation.isPending ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
