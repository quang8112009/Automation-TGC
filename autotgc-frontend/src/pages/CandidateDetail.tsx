/**
 * CandidateDetail (/candidates/:id) — full candidate profile + stage-history
 * timeline, with controls to:
 *   - advance the stage (PUT { stage }; only legal next stages are offered),
 *   - match the candidate to an OPEN job order (POST /match),
 *   - run the AI consultant panel: suggest ranked job orders and draft an
 *     outreach message for this candidate.
 *
 * AI grounding note: the suggest/draft endpoints return `aiGenerated`. When it
 * is false the result is a deterministic, knowledge-grounded answer (no Gemini
 * call) — we surface this clearly as "Trả lời dựa trên cơ sở tri thức", never
 * as a failure.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addCandidateDocument,
  deleteCandidate,
  getCandidate,
  initCandidateDocuments,
  listCandidateDocuments,
  listJobOrders,
  matchCandidate,
  updateCandidate,
  updateDocumentStatus,
} from '../api/recruitment';
import type {
  DocSubmissionStatus,
  DocumentChecklistItem,
  DocumentChecklistResult,
} from '../api/recruitment';
import { aiDraftOutreach, aiSuggestJobOrders, aiConsult } from '../api/aiConsultant';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorMessage, Loading, SuccessMessage, formatDate } from '../components/ui';
import { StageBadge } from '../components/StageBadge';
import { AiGroundingBadge } from '../components/AiGroundingBadge';
import { Icon } from '../components/Icon';
import {
  allowedNextStages,
  candidateStageLabel,
  marketLabel,
  visaTypeLabel,
} from '../lib/recruitment';
import type {
  CandidateDetail as CandidateDetailType,
  CandidateStage,
  CandidateStageHistoryEntry,
  JobOrderSuggestion,
} from '../lib/types';

export function CandidateDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { role } = useAuth();
  const isAdmin = role === 'ADMIN';

  const candidateQuery = useQuery({
    queryKey: ['candidates', 'detail', id],
    queryFn: () => getCandidate(id),
    enabled: id.length > 0,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['candidates'] });
    void queryClient.invalidateQueries({ queryKey: ['candidateStats'] });
  }

  const deleteMutation = useMutation({
    mutationFn: () => deleteCandidate(id),
    onSuccess: () => {
      invalidate();
      navigate('/candidates');
    },
  });

  function confirmDelete() {
    if (window.confirm('Xóa ứng viên này? Hành động không thể hoàn tác.')) {
      deleteMutation.mutate();
    }
  }

  if (id.length === 0) {
    return <Empty label="Thiếu mã ứng viên." />;
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">CRM tuyển dụng</div>
          <h1 className="page-title">Hồ sơ ứng viên</h1>
        </div>
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => navigate('/candidates')}>
            <Icon name="arrow-left" size={16} />
            Danh sách
          </button>
          {isAdmin && (
            <button
              className="btn btn-danger btn-sm"
              disabled={deleteMutation.isPending}
              onClick={confirmDelete}
            >
              Xóa
            </button>
          )}
        </div>
      </div>

      {deleteMutation.error != null && <ErrorMessage error={deleteMutation.error} />}

      {candidateQuery.isLoading ? (
        <Loading label="Đang tải…" />
      ) : candidateQuery.error ? (
        <ErrorMessage error={candidateQuery.error} />
      ) : candidateQuery.data ? (
        <div className="grid grid-2">
          <div>
            <ProfileCard candidate={candidateQuery.data} />
            <StageControls
              candidateId={id}
              currentStage={candidateQuery.data.stage}
              onChanged={() => {
                void queryClient.invalidateQueries({ queryKey: ['candidates', 'detail', id] });
                invalidate();
              }}
            />
            <MatchPanel
              candidateId={id}
              matchedJobOrderId={candidateQuery.data.matchedJobOrderId}
              onMatched={() => {
                void queryClient.invalidateQueries({ queryKey: ['candidates', 'detail', id] });
                invalidate();
              }}
            />
          </div>
          <div>
            <HistoryTimeline history={candidateQuery.data.history} />
            <CandidateCopilotPanel candidateId={id} />
            <AiConsultPanel candidateId={id} />
            <DocumentChecklistPanel candidateId={id} desiredMarket={candidateQuery.data.desiredMarket} />
          </div>
        </div>
      ) : (
        <Empty label="Không tìm thấy ứng viên." />
      )}
    </div>
  );
}

function ProfileCard({ candidate }: { candidate: CandidateDetailType }) {
  return (
    <div className="card">
      <h2 className="card-title">
        {candidate.fullName} <StageBadge stage={candidate.stage} />
      </h2>
      <dl className="kv">
        <dt>Điện thoại</dt>
        <dd>{candidate.phone ?? '—'}</dd>
        <dt>Email</dt>
        <dd>{candidate.email ?? '—'}</dd>
        <dt>Ngày sinh</dt>
        <dd>{candidate.dob ? formatDate(candidate.dob) : '—'}</dd>
        <dt>Giới tính</dt>
        <dd>{candidate.gender || '—'}</dd>
        <dt>Quê quán</dt>
        <dd>{candidate.hometown || '—'}</dd>
        <dt>Học vấn</dt>
        <dd>{candidate.education || '—'}</dd>
        <dt>Công việc hiện tại</dt>
        <dd>{candidate.currentJob || '—'}</dd>
        <dt>Thị trường mong muốn</dt>
        <dd>{marketLabel(candidate.desiredMarket)}</dd>
        <dt>Diện visa mong muốn</dt>
        <dd>{visaTypeLabel(candidate.desiredVisaType)}</dd>
        <dt>Ngành mong muốn</dt>
        <dd>{candidate.desiredIndustry || '—'}</dd>
        <dt>Trình độ tiếng Nhật</dt>
        <dd>{candidate.japaneseLevel || '—'}</dd>
        <dt>Ngoại ngữ khác</dt>
        <dd>{candidate.otherLanguage || '—'}</dd>
        <dt>Nguồn</dt>
        <dd>{candidate.source || '—'}</dd>
        <dt>Người phụ trách</dt>
        <dd>{candidate.assignedTo ?? '—'}</dd>
        <dt>Ghi chú</dt>
        <dd>{candidate.note ?? '—'}</dd>
        <dt>Ngày tạo</dt>
        <dd>{formatDate(candidate.createdAt)}</dd>
      </dl>
    </div>
  );
}

function StageControls({
  candidateId,
  currentStage,
  onChanged,
}: {
  candidateId: string;
  currentStage: CandidateStage;
  onChanged: () => void;
}) {
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const nextStages = allowedNextStages(currentStage);

  const mutation = useMutation({
    mutationFn: () => updateCandidate(candidateId, { stage: target, note: note || null }),
    onSuccess: () => {
      setMessage(`Đã chuyển sang giai đoạn "${candidateStageLabel(target)}".`);
      setTarget('');
      setNote('');
      onChanged();
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Chuyển giai đoạn</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Giai đoạn hiện tại: <strong>{candidateStageLabel(currentStage)}</strong>. Hệ thống chỉ cho
        phép các bước hợp lệ (server từ chối bước sai với mã 409).
      </div>
      {message && <SuccessMessage>{message}</SuccessMessage>}
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {nextStages.length === 0 ? (
        <div className="muted">Đây là giai đoạn kết thúc — không thể chuyển tiếp.</div>
      ) : (
        <>
          <div className="field">
            <label>Giai đoạn mới</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">— Chọn —</option>
              {nextStages.map((s) => (
                <option key={s} value={s}>
                  {candidateStageLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Ghi chú (tùy chọn)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={!target || mutation.isPending}
            onClick={() => {
              setMessage(null);
              mutation.mutate();
            }}
          >
            {mutation.isPending ? 'Đang chuyển…' : 'Chuyển giai đoạn'}
          </button>
        </>
      )}
    </div>
  );
}

function MatchPanel({
  candidateId,
  matchedJobOrderId,
  onMatched,
}: {
  candidateId: string;
  matchedJobOrderId: string | null;
  onMatched: () => void;
}) {
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const openOrdersQuery = useQuery({
    queryKey: ['jobOrders', 'open-for-match'],
    queryFn: () => listJobOrders({ status: 'OPEN', limit: 100 }),
  });

  const mutation = useMutation({
    mutationFn: () => matchCandidate(candidateId, selected),
    onSuccess: () => {
      setMessage('Đã ghép ứng viên với đơn hàng (giai đoạn chuyển sang Đã ghép đơn).');
      setSelected('');
      onMatched();
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Ghép đơn hàng</h2>
      {matchedJobOrderId && (
        <div className="muted" style={{ marginBottom: 10 }}>
          Đơn hàng đã ghép hiện tại: <code>{matchedJobOrderId}</code>
        </div>
      )}
      {message && <SuccessMessage>{message}</SuccessMessage>}
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {openOrdersQuery.isLoading ? (
        <Loading label="Đang tải đơn hàng…" />
      ) : openOrdersQuery.error ? (
        <ErrorMessage error={openOrdersQuery.error} />
      ) : openOrdersQuery.data && openOrdersQuery.data.items.length > 0 ? (
        <>
          <div className="field">
            <label>Chọn đơn hàng đang tuyển</label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">— Chọn đơn hàng —</option>
              {openOrdersQuery.data.items.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} — {o.title} ({marketLabel(o.market)})
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn btn--secondary btn-sm"
            disabled={!selected || mutation.isPending}
            onClick={() => {
              setMessage(null);
              mutation.mutate();
            }}
          >
            {mutation.isPending ? 'Đang ghép…' : 'Ghép đơn hàng'}
          </button>
        </>
      ) : (
        <Empty label="Không có đơn hàng nào đang tuyển." />
      )}
    </div>
  );
}

function HistoryTimeline({ history }: { history: CandidateStageHistoryEntry[] }) {
  return (
    <div className="card">
      <h2 className="card-title">Lịch sử giai đoạn</h2>
      {history.length === 0 ? (
        <div className="muted">Chưa có thay đổi giai đoạn nào.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Thời điểm</th>
                <th>Từ → Đến</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{formatDate(h.changedAt)}</td>
                  <td>
                    {candidateStageLabel(h.previousStage)} → {candidateStageLabel(h.newStage)}
                  </td>
                  <td>{h.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Copilot chat sidebar (proposal 3.2): free-form Q&A grounded on the candidate's
 * profile via /api/v1/ai/consult (RAG over KnowledgeEntry; candidateId scopes
 * the answer). Works with no Gemini key — the backend returns a deterministic,
 * knowledge-grounded answer flagged aiGenerated:false (surfaced, not an error).
 */
function CandidateCopilotPanel({ candidateId }: { candidateId: string }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<
    Array<{ q: string; answer: string; aiGenerated: boolean }>
  >([]);

  const askMutation = useMutation({
    mutationFn: (q: string) => aiConsult(q, candidateId),
    onSuccess: (result, q) => {
      setTurns((prev) => [
        ...prev,
        { q, answer: result.answer, aiGenerated: result.aiGenerated },
      ]);
      setQuestion('');
    },
  });

  const examples = [
    'Ứng viên này phù hợp đơn hàng nào?',
    'Cần chuẩn bị giấy tờ gì cho thị trường mong muốn?',
    'Lộ trình và chi phí dự kiến ra sao?',
  ];

  function ask(q: string) {
    const trimmed = q.trim();
    if (trimmed.length === 0 || askMutation.isPending) return;
    askMutation.mutate(trimmed);
  }

  return (
    <div className="card">
      <h2 className="card-title">Copilot tư vấn</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Hỏi nhanh về ứng viên này — Copilot trả lời dựa trên cơ sở tri thức và hồ sơ. Khi chưa cấu
        hình AI, câu trả lời vẫn bám sát dữ liệu nền (không phải lỗi).
      </div>

      {turns.length > 0 && (
        <div className="steps-list" style={{ marginBottom: 12 }}>
          {turns.map((t, i) => (
            <div key={i} className="step-row" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                <Icon name="bot" size={14} /> {t.q}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <AiGroundingBadge aiGenerated={t.aiGenerated} />
              </div>
              <pre className="code" style={{ whiteSpace: 'pre-wrap', width: '100%' }}>
                {t.answer}
              </pre>
            </div>
          ))}
        </div>
      )}

      {askMutation.error != null && <ErrorMessage error={askMutation.error} />}

      <div className="field">
        <label>Câu hỏi</label>
        <textarea
          value={question}
          placeholder="VD: Ứng viên 25 tuổi, tiếng Nhật N4 thì đi được đơn hàng nào?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(question);
          }}
        />
      </div>
      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {examples.map((ex) => (
          <button
            key={ex}
            className="btn btn-sm"
            disabled={askMutation.isPending}
            onClick={() => ask(ex)}
          >
            {ex}
          </button>
        ))}
      </div>
      <button
        className="btn btn-primary btn-sm"
        disabled={question.trim().length === 0 || askMutation.isPending}
        onClick={() => ask(question)}
      >
        {askMutation.isPending ? 'Đang hỏi…' : 'Hỏi Copilot'}
      </button>
    </div>
  );
}

function AiConsultPanel({ candidateId }: { candidateId: string }) {
  const [suggestions, setSuggestions] = useState<JobOrderSuggestion[] | null>(null);
  const [outreach, setOutreach] = useState<{ message: string; aiGenerated: boolean } | null>(null);
  const [outreachJobOrderId, setOutreachJobOrderId] = useState<string | null>(null);

  const suggestMutation = useMutation({
    mutationFn: () => aiSuggestJobOrders(candidateId),
    onSuccess: (result) => {
      setSuggestions(Array.isArray(result.suggestions) ? result.suggestions : []);
      setOutreach(null);
      setOutreachJobOrderId(null);
    },
  });

  const draftMutation = useMutation({
    mutationFn: (jobOrderId: string) => aiDraftOutreach(candidateId, jobOrderId),
    onSuccess: (result, jobOrderId) => {
      setOutreach({ message: result.message, aiGenerated: result.aiGenerated });
      setOutreachJobOrderId(jobOrderId);
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Tư vấn AI</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Gợi ý đơn hàng phù hợp và soạn tin nhắn tiếp cận cho ứng viên này. Khi chưa cấu hình AI, hệ
        thống vẫn trả lời dựa trên cơ sở tri thức.
      </div>

      <button
        className="btn btn--secondary btn-sm"
        disabled={suggestMutation.isPending}
        onClick={() => suggestMutation.mutate()}
      >
        {suggestMutation.isPending ? 'Đang phân tích…' : 'Gợi ý đơn hàng phù hợp'}
      </button>

      {suggestMutation.error != null && (
        <div style={{ marginTop: 12 }}>
          <ErrorMessage error={suggestMutation.error} />
        </div>
      )}

      {suggestions != null && (
        <div style={{ marginTop: 14 }}>
          {suggestions.length === 0 ? (
            <Empty label="Chưa tìm thấy đơn hàng phù hợp. Hãy bổ sung nguyện vọng cho ứng viên hoặc thêm đơn hàng đang tuyển." />
          ) : (
            <div className="steps-list">
              {suggestions.map((s) => (
                <div key={s.jobOrderId} className="step-row" style={{ alignItems: 'flex-start' }}>
                  <div className="step-index">{s.score}</div>
                  <div style={{ flex: 1 }}>
                    <div>
                      <strong>{s.code}</strong> — {s.title}
                    </div>
                    {Array.isArray(s.reasons) && s.reasons.length > 0 && (
                      <div className="muted" style={{ marginTop: 4 }}>
                        {s.reasons.join(' · ')}
                      </div>
                    )}
                    <button
                      className="btn btn-sm"
                      style={{ marginTop: 6 }}
                      disabled={draftMutation.isPending}
                      onClick={() => draftMutation.mutate(s.jobOrderId)}
                    >
                      {draftMutation.isPending && outreachJobOrderId === s.jobOrderId
                        ? 'Đang soạn…'
                        : 'Soạn tin tiếp cận'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {draftMutation.error != null && (
        <div style={{ marginTop: 12 }}>
          <ErrorMessage error={draftMutation.error} />
        </div>
      )}

      {outreach != null && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong>Tin nhắn tiếp cận</strong>
            <AiGroundingBadge aiGenerated={outreach.aiGenerated} />
          </div>
          <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>
            {outreach.message}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---- Document checklist -----------------------------------------------------
//
// Per-candidate document/certificate checklist (Requirements 11.2, 13.1, 13.3,
// 13.4). Shows required vs optional and source (DEFAULT/CUSTOM), a completion
// progress bar (rendered as "Chưa đủ dữ liệu" when the backend returns
// 'INSUFFICIENT_DATA'), a per-market seed button, an add-custom-type control,
// and a per-item submission-status control. Status changes update the cache
// optimistically and recompute the completion metric locally; the server stays
// authoritative and a rollback restores the previous state on error.

const DOC_STATUSES: DocSubmissionStatus[] = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'];

const DOC_STATUS_LABELS: Record<DocSubmissionStatus, string> = {
  PENDING: 'Chờ nộp',
  SUBMITTED: 'Đã nộp',
  VERIFIED: 'Đã xác minh',
  REJECTED: 'Từ chối',
};

const DOC_STATUS_BADGE: Record<DocSubmissionStatus, string> = {
  PENDING: 'badge-gray',
  SUBMITTED: 'badge-yellow',
  VERIFIED: 'badge-green',
  REJECTED: 'badge-red',
};

/**
 * Recompute the completion metric locally so optimistic status changes reflect
 * immediately. Mirrors the backend formula: (required items VERIFIED) / (total
 * required), returning 'INSUFFICIENT_DATA' when there are no required items.
 */
function recomputeCompletion(
  items: DocumentChecklistItem[],
): number | 'INSUFFICIENT_DATA' {
  let totalRequired = 0;
  let verifiedRequired = 0;
  for (const item of items) {
    if (!item.required) continue;
    totalRequired += 1;
    if (item.status === 'VERIFIED') verifiedRequired += 1;
  }
  if (totalRequired === 0) return 'INSUFFICIENT_DATA';
  return verifiedRequired / totalRequired;
}

function CompletionBar({
  completion,
}: {
  completion: number | 'INSUFFICIENT_DATA';
}) {
  if (completion === 'INSUFFICIENT_DATA') {
    return (
      <div className="muted" style={{ marginBottom: 12 }}>
        Tiến độ hồ sơ: <strong>Chưa đủ dữ liệu</strong> (chưa có giấy tờ bắt buộc nào).
      </div>
    );
  }
  const pct = Math.round(completion * 100);
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 'var(--fs-sm)',
          marginBottom: 4,
        }}
      >
        <span className="muted">Tiến độ hoàn thành hồ sơ (giấy tờ bắt buộc đã xác minh)</span>
        <strong>{pct}%</strong>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 8,
          borderRadius: 'var(--radius-pill)',
          background: 'var(--stone-200)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 'var(--radius-pill)',
            background: pct === 100 ? 'var(--success)' : 'var(--color-gold)',
            transition: 'width var(--dur-base) var(--ease)',
          }}
        />
      </div>
    </div>
  );
}

function DocumentChecklistPanel({
  candidateId,
  desiredMarket,
}: {
  candidateId: string;
  desiredMarket: string | null;
}) {
  const queryClient = useQueryClient();
  const docsKey = ['candidates', 'documents', candidateId] as const;

  const [label, setLabel] = useState('');
  const [required, setRequired] = useState(true);
  const [labelError, setLabelError] = useState<string | null>(null);

  const documentsQuery = useQuery({
    queryKey: docsKey,
    queryFn: () => listCandidateDocuments(candidateId),
    enabled: candidateId.length > 0,
  });

  const initMutation = useMutation({
    mutationFn: () => initCandidateDocuments(candidateId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: docsKey });
    },
  });

  const addMutation = useMutation({
    mutationFn: () => addCandidateDocument(candidateId, { label: label.trim(), required }),
    onSuccess: () => {
      setLabel('');
      setRequired(true);
      setLabelError(null);
      void queryClient.invalidateQueries({ queryKey: docsKey });
    },
  });

  // Optimistic status update: patch the cached item and recompute completion,
  // rolling back to the snapshot on error. The server remains authoritative
  // (it rejects values outside the four-value enum with 400).
  const statusMutation = useMutation({
    mutationFn: ({ itemId, status }: { itemId: string; status: DocSubmissionStatus }) =>
      updateDocumentStatus(itemId, status),
    onMutate: async ({ itemId, status }) => {
      await queryClient.cancelQueries({ queryKey: docsKey });
      const previous = queryClient.getQueryData<DocumentChecklistResult>(docsKey);
      if (previous) {
        const items = previous.items.map((it) =>
          it.id === itemId ? { ...it, status } : it,
        );
        queryClient.setQueryData<DocumentChecklistResult>(docsKey, {
          items,
          completion: recomputeCompletion(items),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(docsKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: docsKey });
    },
  });

  function submitCustom() {
    if (label.trim().length === 0) {
      setLabelError('Vui lòng nhập tên loại giấy tờ.');
      return;
    }
    setLabelError(null);
    addMutation.mutate();
  }

  const data = documentsQuery.data;

  return (
    <div className="card">
      <h2 className="card-title">Checklist giấy tờ</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Theo dõi giấy tờ/chứng chỉ của ứng viên. Bộ mặc định khởi tạo theo thị trường mong muốn
        {desiredMarket ? ` (${marketLabel(desiredMarket)})` : ' (chưa rõ → dùng bộ "Khác")'}.
      </div>

      <div className="row-actions" style={{ marginBottom: 14 }}>
        <button
          className="btn btn--secondary btn-sm"
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? 'Đang khởi tạo…' : 'Khởi tạo theo thị trường'}
        </button>
      </div>

      {initMutation.error != null && <ErrorMessage error={initMutation.error} />}

      {documentsQuery.isLoading ? (
        <Loading label="Đang tải checklist…" />
      ) : documentsQuery.error ? (
        <ErrorMessage error={documentsQuery.error} />
      ) : data ? (
        <>
          <CompletionBar completion={data.completion} />

          {statusMutation.error != null && <ErrorMessage error={statusMutation.error} />}

          {data.items.length === 0 ? (
            <Empty label='Chưa có giấy tờ nào. Bấm "Khởi tạo theo thị trường" hoặc thêm loại tùy biến bên dưới.' />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Loại giấy tờ</th>
                    <th>Bắt buộc</th>
                    <th>Nguồn</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td style={{ whiteSpace: 'normal' }}>
                        {item.status === 'VERIFIED' && (
                          <Icon
                            name="check"
                            size={14}
                            style={{ color: 'var(--success)', marginRight: 6 }}
                          />
                        )}
                        {item.label}
                      </td>
                      <td>
                        {item.required ? (
                          <span className="badge badge-blue">Bắt buộc</span>
                        ) : (
                          <span className="badge badge-gray">Tùy chọn</span>
                        )}
                      </td>
                      <td>
                        <span className="badge badge-gray">
                          {item.source === 'DEFAULT' ? 'Mặc định' : 'Tùy biến'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={`badge ${DOC_STATUS_BADGE[item.status]}`}>
                            {DOC_STATUS_LABELS[item.status]}
                          </span>
                          <select
                            aria-label={`Trạng thái: ${item.label}`}
                            value={item.status}
                            disabled={statusMutation.isPending}
                            onChange={(e) =>
                              statusMutation.mutate({
                                itemId: item.id,
                                status: e.target.value as DocSubmissionStatus,
                              })
                            }
                            style={{ width: 'auto', height: 32, padding: '4px 8px' }}
                          >
                            {DOC_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {DOC_STATUS_LABELS[s]}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="divider" />

          <h3 style={{ fontSize: 'var(--fs-h3)', margin: '0 0 10px' }}>Thêm loại giấy tờ</h3>
          {labelError && <ErrorMessage error={labelError} />}
          {addMutation.error != null && <ErrorMessage error={addMutation.error} />}
          <div className="field">
            <label>Tên loại giấy tờ</label>
            <input
              value={label}
              placeholder="VD: Giấy xác nhận kinh nghiệm"
              onChange={(e) => {
                setLabel(e.target.value);
                if (labelError) setLabelError(null);
              }}
            />
          </div>
          <div className="field">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                style={{ width: 'auto', height: 'auto' }}
              />
              Bắt buộc
            </label>
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={addMutation.isPending}
            onClick={submitCustom}
          >
            <Icon name="plus" size={16} />
            {addMutation.isPending ? 'Đang thêm…' : 'Thêm loại giấy tờ'}
          </button>
        </>
      ) : (
        <Empty label="Không tải được checklist." />
      )}
    </div>
  );
}
