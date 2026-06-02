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
import { getDestinationSuggestions } from '../api/partners';
import {
  getScholarshipSuggestions,
  listDocExtractions,
  submitDocExtraction,
} from '../api/studyAbroad';
import type {
  DocumentExtraction,
  ScholarshipResult,
} from '../lib/types';
import {
  createVisaCase,
  generateLogistics,
  getVisaAdvice,
  listVisaCases,
  updateVisaTask,
} from '../api/visa';
import type { DestinationSuggestion, VisaCase, VisaTask } from '../lib/types';
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
            <DestinationSuggestionsPanel candidateId={id} />
            <ScholarshipPanel candidateId={id} />
            <VisaCasesPanel candidateId={id} desiredMarket={candidateQuery.data.desiredMarket} />
            <DocExtractionPanel candidateId={id} />
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

// ---- Destination suggestions (đối chiếu DB & gợi ý cho tư vấn) --------------

const SUGG_MARKET_LABEL: Record<string, string> = {
  JAPAN: 'Nhật Bản',
  KOREA: 'Hàn Quốc',
  GERMANY: 'Đức',
  TAIWAN: 'Đài Loan',
  AUSTRALIA: 'Úc',
  USA: 'Mỹ',
  CANADA: 'Canada',
  UK: 'Anh',
  OTHER: 'Khác',
};

function DestinationSuggestionsPanel({ candidateId }: { candidateId: string }) {
  const [suggestions, setSuggestions] = useState<DestinationSuggestion[] | null>(null);

  const mutation = useMutation({
    mutationFn: () => getDestinationSuggestions(candidateId),
    onSuccess: (res) => setSuggestions(res.suggestions),
  });

  return (
    <div className="card">
      <h2 className="card-title">Gợi ý điểm đến phù hợp</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Đối chiếu hồ sơ ứng viên với cơ sở dữ liệu chương trình XKLĐ và xếp hạng theo độ phù hợp
        (đủ điều kiện ưu tiên trước, kèm lý do nếu chưa đạt).
      </div>
      <button className="btn btn--secondary btn-sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Đang đối chiếu…' : 'Gợi ý điểm đến'}
      </button>
      {mutation.error != null && <div style={{ marginTop: 12 }}><ErrorMessage error={mutation.error} /></div>}

      {suggestions != null && (
        <div style={{ marginTop: 14 }}>
          {suggestions.length === 0 ? (
            <Empty label="Chưa tìm thấy chương trình phù hợp. Hãy bổ sung dữ liệu điểm đến hoặc nguyện vọng ứng viên." />
          ) : (
            <div className="steps-list">
              {suggestions.map((s) => (
                <div key={s.programId} className="step-row" style={{ alignItems: 'flex-start' }}>
                  <div className="step-index" style={{ background: s.eligible ? 'var(--success, #2e7d32)' : 'var(--stone-300, #bbb)' }}>
                    {s.score}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div>
                      <strong>{s.name}</strong>{' '}
                      <span className="muted">· {SUGG_MARKET_LABEL[s.country] ?? s.country}</span>{' '}
                      {s.eligible ? (
                        <span className="badge badge-green">Đủ điều kiện</span>
                      ) : (
                        <span className="badge badge-red">Chưa đạt</span>
                      )}
                    </div>
                    {s.matched.length > 0 && (
                      <div className="muted" style={{ marginTop: 4, fontSize: 'var(--fs-xs)' }}>
                        ✓ {s.matched.join(' · ')}
                      </div>
                    )}
                    {s.blockers.length > 0 && (
                      <div style={{ marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--danger, #c0392b)' }}>
                        ✗ {s.blockers.join(' · ')}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Visa Smart Checklist + logistics + AI advisory ------------------------

const VISA_COUNTRIES = ['AUSTRALIA', 'USA', 'CANADA', 'UK', 'JAPAN', 'KOREA', 'GERMANY', 'TAIWAN'];
const VISA_TASK_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ làm',
  IN_PROGRESS: 'Đang làm',
  DONE: 'Hoàn tất',
  BLOCKED: 'Vướng mắc',
};
const VISA_TASK_STATUS_BADGE: Record<string, string> = {
  PENDING: 'badge-gray',
  IN_PROGRESS: 'badge-yellow',
  DONE: 'badge-green',
  BLOCKED: 'badge-red',
};
const VISA_TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'];

function VisaCasesPanel({
  candidateId,
  desiredMarket,
}: {
  candidateId: string;
  desiredMarket: string | null;
}) {
  const queryClient = useQueryClient();
  const casesKey = ['visa', 'cases', candidateId] as const;
  const [country, setCountry] = useState(desiredMarket && VISA_COUNTRIES.includes(desiredMarket) ? desiredMarket : 'AUSTRALIA');
  const [intakeDate, setIntakeDate] = useState('');

  const casesQuery = useQuery({
    queryKey: casesKey,
    queryFn: () => listVisaCases(candidateId),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createVisaCase({ candidateId, country, targetIntakeDate: intakeDate || undefined }),
    onSuccess: () => {
      setIntakeDate('');
      void queryClient.invalidateQueries({ queryKey: casesKey });
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Hồ sơ Visa &amp; Đưa đón</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Tạo checklist hồ sơ visa tùy chỉnh theo quốc gia (kèm hạn nộp tự tính) và gợi ý hậu cần
        (bảo hiểm OSHC/IHS, vé máy bay, đưa đón sân bay, chỗ ở).
      </div>

      <div className="toolbar">
        <div className="field">
          <label>Quốc gia</label>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {VISA_COUNTRIES.map((c) => (
              <option key={c} value={c}>{SUGG_MARKET_LABEL[c] ?? c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Ngày nhập học/xuất cảnh (dự kiến)</label>
          <input type="date" value={intakeDate} onChange={(e) => setIntakeDate(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          <Icon name="plus" size={16} /> {createMutation.isPending ? 'Đang tạo…' : 'Tạo hồ sơ'}
        </button>
      </div>
      {createMutation.error != null && <ErrorMessage error={createMutation.error} />}

      {casesQuery.isLoading ? (
        <Loading label="Đang tải…" />
      ) : casesQuery.error ? (
        <ErrorMessage error={casesQuery.error} />
      ) : casesQuery.data && casesQuery.data.items.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          {casesQuery.data.items.map((c) => (
            <VisaCaseCard key={c.id} visaCase={c} onChanged={() => queryClient.invalidateQueries({ queryKey: casesKey })} />
          ))}
        </div>
      ) : (
        <Empty label="Chưa có hồ sơ visa nào. Tạo một hồ sơ ở trên." />
      )}
    </div>
  );
}

function VisaCaseCard({ visaCase, onChanged }: { visaCase: VisaCase; onChanged: () => void }) {
  const [advice, setAdvice] = useState<string | null>(null);

  const adviceMutation = useMutation({
    mutationFn: () => getVisaAdvice(visaCase.id),
    onSuccess: (res) => setAdvice(res.advisory),
  });
  const logisticsMutation = useMutation({
    mutationFn: () => generateLogistics(visaCase.id),
    onSuccess: () => onChanged(),
  });
  const taskStatusMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: string }) =>
      updateVisaTask(taskId, { status }),
    onSuccess: () => onChanged(),
  });

  const tasks: VisaTask[] = visaCase.tasks ?? [];
  const done = tasks.filter((t) => t.status === 'DONE').length;

  return (
    <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <strong>{SUGG_MARKET_LABEL[visaCase.country] ?? visaCase.country}</strong>{' '}
          <span className="badge badge-blue">{visaCase.status}</span>
          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            {done}/{tasks.length} mục hoàn tất
            {visaCase.targetIntakeDate ? ` · nhập học ${formatDate(visaCase.targetIntakeDate)}` : ''}
          </div>
        </div>
        <div className="row-actions">
          <button className="btn btn-sm" disabled={adviceMutation.isPending} onClick={() => adviceMutation.mutate()}>
            <Icon name="sparkles" size={14} /> {adviceMutation.isPending ? 'Đang tư vấn…' : 'Tư vấn AI'}
          </button>
          <button className="btn btn-sm" disabled={logisticsMutation.isPending} onClick={() => logisticsMutation.mutate()}>
            {logisticsMutation.isPending ? 'Đang tạo…' : 'Gợi ý hậu cần'}
          </button>
        </div>
      </div>

      {advice && (
        <pre className="code" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>{advice}</pre>
      )}

      {visaCase.logistics && (
        <div className="success-box" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          <strong>Hậu cần:</strong> Bảo hiểm {visaCase.logistics.insuranceType || '—'} · Chỗ ở{' '}
          {visaCase.logistics.housingType || '—'}
          {visaCase.logistics.notes ? `\n${visaCase.logistics.notes}` : ''}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Mục</th>
                <th>Loại</th>
                <th>Hạn</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'normal' }}>
                    {t.label} {t.required && <span className="badge badge-blue">Bắt buộc</span>}
                  </td>
                  <td>{t.category}</td>
                  <td>{t.dueAt ? formatDate(t.dueAt) : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`badge ${VISA_TASK_STATUS_BADGE[t.status]}`}>
                        {VISA_TASK_STATUS_LABEL[t.status]}
                      </span>
                      <select
                        value={t.status}
                        disabled={taskStatusMutation.isPending}
                        onChange={(e) => taskStatusMutation.mutate({ taskId: t.id, status: e.target.value })}
                        style={{ width: 'auto', height: 32, padding: '4px 8px' }}
                      >
                        {VISA_TASK_STATUSES.map((s) => (
                          <option key={s} value={s}>{VISA_TASK_STATUS_LABEL[s]}</option>
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
    </div>
  );
}

// ---- Scholarship / financial matching (Du học) -----------------------------

function ScholarshipPanel({ candidateId }: { candidateId: string }) {
  const [budget, setBudget] = useState('');
  const [gpa, setGpa] = useState('');
  const [ielts, setIelts] = useState('');
  const [results, setResults] = useState<ScholarshipResult[] | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      getScholarshipSuggestions(candidateId, {
        budgetPerYearVndM: budget ? Number(budget) : undefined,
        gpa: gpa ? Number(gpa) : undefined,
        ielts: ielts ? Number(ielts) : undefined,
      }),
    onSuccess: (res) => setResults(res.results),
  });

  return (
    <div className="card">
      <h2 className="card-title">Học bổng &amp; Tài chính</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Nhập ngân sách/năm + GPA + IELTS để hệ thống tính chi phí, ước tính học bổng và tìm chương
        trình trong khả năng chi trả.
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Ngân sách/năm (triệu VND)</label>
          <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="VD: 300" />
        </div>
        <div className="field">
          <label>GPA (thang 10)</label>
          <input type="number" step="0.1" value={gpa} onChange={(e) => setGpa(e.target.value)} placeholder="VD: 8.0" />
        </div>
        <div className="field">
          <label>IELTS</label>
          <input type="number" step="0.5" value={ielts} onChange={(e) => setIelts(e.target.value)} placeholder="VD: 6.5" />
        </div>
      </div>
      <button className="btn btn--secondary btn-sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Đang tính…' : 'Gợi ý học bổng & chi phí'}
      </button>
      {mutation.error != null && <div style={{ marginTop: 12 }}><ErrorMessage error={mutation.error} /></div>}

      {results != null && (
        <div style={{ marginTop: 14 }}>
          {results.length === 0 ? (
            <Empty label="Chưa có chương trình du học nào có dữ liệu tài chính. Hãy bổ sung học phí/học bổng cho điểm đến." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Chương trình</th>
                    <th>Tổng CP/năm</th>
                    <th>Học bổng ước tính</th>
                    <th>CP ròng/năm</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.programId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        {r.notes.length > 0 && (
                          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{r.notes.join(' · ')}</div>
                        )}
                      </td>
                      <td>{r.totalCostPerYearVndM} tr</td>
                      <td>{r.estScholarshipPct}% (≈{r.estScholarshipVndM} tr)</td>
                      <td>{r.netCostPerYearVndM} tr</td>
                      <td>
                        {r.affordable ? (
                          <span className="badge badge-green">Đủ ngân sách</span>
                        ) : (
                          <span className="badge badge-red">Thiếu {r.shortfallVndM} tr</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Document OCR & verification (Du học) ----------------------------------

const DOC_EXTRACT_TYPES = ['IELTS', 'TOEFL', 'TRANSCRIPT', 'FINANCIAL', 'PASSPORT', 'OTHER'];
const DOC_EXTRACT_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ xử lý',
  EXTRACTED: 'Đã bóc tách',
  VERIFIED: 'Đã xác thực',
  FAILED: 'Không đạt',
  NEEDS_RESEND: 'Cần gửi lại',
};
const DOC_EXTRACT_STATUS_BADGE: Record<string, string> = {
  PENDING: 'badge-gray',
  EXTRACTED: 'badge-blue',
  VERIFIED: 'badge-green',
  FAILED: 'badge-red',
  NEEDS_RESEND: 'badge-yellow',
};

function DocExtractionPanel({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const key = ['docExtractions', candidateId] as const;
  const [docType, setDocType] = useState('IELTS');
  const [rawText, setRawText] = useState('');
  const [minScore, setMinScore] = useState('');

  const listQuery = useQuery({
    queryKey: key,
    queryFn: () => listDocExtractions(candidateId),
  });

  const submitMutation = useMutation({
    mutationFn: () =>
      submitDocExtraction({
        candidateId,
        docType,
        rawText: rawText.trim() || undefined,
        requirement: minScore ? { minScore: Number(minScore) } : undefined,
      }),
    onSuccess: () => {
      setRawText('');
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Bóc tách &amp; Xác thực hồ sơ (AI)</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Dán nội dung OCR của chứng chỉ (VD: "Overall Band Score 6.5") để hệ thống bóc tách điểm và
        tự đối chiếu yêu cầu. Khi chưa cắm vision model, hệ thống sẽ yêu cầu gửi lại ảnh rõ hơn.
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Loại giấy tờ</label>
          <select value={docType} onChange={(e) => setDocType(e.target.value)}>
            {DOC_EXTRACT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Điểm yêu cầu tối thiểu (tùy chọn)</label>
          <input type="number" step="0.5" value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="VD: 6.0" />
        </div>
      </div>
      <div className="field">
        <label>Nội dung OCR / văn bản chứng chỉ</label>
        <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} placeholder="Dán text đọc được từ ảnh chứng chỉ…" />
      </div>
      <button className="btn btn-primary btn-sm" disabled={submitMutation.isPending} onClick={() => submitMutation.mutate()}>
        <Icon name="sparkles" size={16} /> {submitMutation.isPending ? 'Đang xử lý…' : 'Bóc tách & xác thực'}
      </button>
      {submitMutation.error != null && <ErrorMessage error={submitMutation.error} />}

      {listQuery.isLoading ? (
        <Loading label="Đang tải…" />
      ) : listQuery.data && listQuery.data.items.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Loại</th>
                <th>Kết quả bóc tách</th>
                <th>Trạng thái</th>
                <th>Vấn đề</th>
              </tr>
            </thead>
            <tbody>
              {listQuery.data.items.map((d: DocumentExtraction) => (
                <tr key={d.id}>
                  <td>{d.docType}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {Object.entries(d.extractedFields ?? {})
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(', ') || '—'}
                  </td>
                  <td>
                    <span className={`badge ${DOC_EXTRACT_STATUS_BADGE[d.status] ?? 'badge-gray'}`}>
                      {DOC_EXTRACT_STATUS_LABEL[d.status] ?? d.status}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                    {(d.issues ?? []).join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
