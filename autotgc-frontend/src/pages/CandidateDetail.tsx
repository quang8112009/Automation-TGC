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
import { getScholarshipSuggestions } from '../api/studyAbroad';
import {
  createApplication,
  createEssay,
  createRoadmapNarrative,
  deleteEssay,
  estimateRoadmap,
  getAcademicProfile,
  getReadiness,
  getTimeline,
  listApplications,
  listEssays,
  putAcademicProfile,
  reviewEssay,
  scoreAdmissions,
  transitionEssay,
  transitionRoadmapNarrative,
} from '../api/studyAdvisor';
import type {
  AcademicProfileInput,
  AdmissionResult,
  EssayDocType,
  EssayGenMode,
  EssayReview,
  NumericOrInsufficient,
  ReviewStatus,
  RoadmapEstimate,
} from '../api/studyAdvisor';
import type { ScholarshipResult } from '../lib/types';
import {
  createVisaCase,
  generateLogistics,
  getVisaAdvice,
  listVisaCases,
  updateVisaTask,
} from '../api/visa';
import type { DestinationSuggestion, VisaCase, VisaTask } from '../lib/types';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorMessage, Loading, StatCard, SuccessMessage, formatDate } from '../components/ui';
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
            <AdmissionsPanel candidateId={id} />
            <RoadmapPanel candidateId={id} />
            <VisaCasesPanel candidateId={id} desiredMarket={candidateQuery.data.desiredMarket} />
            <TimelinePanel candidateId={id} />
            <DocumentChecklistPanel candidateId={id} desiredMarket={candidateQuery.data.desiredMarket} />
            <EssaysPanel candidateId={id} />
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
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
        <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
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
  const entries = history ?? [];
  return (
    <div className="card">
      <h2 className="card-title">Lịch sử giai đoạn</h2>
      {entries.length === 0 ? (
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
              {entries.map((h) => (
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Hỏi nhanh về ứng viên này — Copilot trả lời dựa trên cơ sở tri thức và hồ sơ. Khi chưa cấu
        hình AI, câu trả lời vẫn bám sát dữ liệu nền (không phải lỗi).
      </div>

      {turns.length > 0 && (
        <div className="steps-list" style={{ marginBottom: 'var(--space-sm)' }}>
          {turns.map((t, i) => (
            <div key={i} className="step-row" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
              <div style={{ fontWeight: 'var(--fw-semibold)', marginBottom: 'var(--space-xs)' }}>
                <Icon name="bot" size={14} /> {t.q}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
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
      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-xs)', marginBottom: 'var(--space-sm)' }}>
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
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
        <div style={{ marginTop: 'var(--space-md)' }}>
          <ErrorMessage error={suggestMutation.error} />
        </div>
      )}

      {suggestions != null && (
        <div style={{ marginTop: 'var(--space-md)' }}>
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
                      <div className="muted" style={{ marginTop: 'var(--space-xs)' }}>
                        {s.reasons.join(' · ')}
                      </div>
                    )}
                    <button
                      className="btn btn-sm"
                      style={{ marginTop: 'var(--space-xs)' }}
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
        <div style={{ marginTop: 'var(--space-md)' }}>
          <ErrorMessage error={draftMutation.error} />
        </div>
      )}

      {outreach != null && (
        <div style={{ marginTop: 'var(--space-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Tiến độ hồ sơ: <strong>Chưa đủ dữ liệu</strong> (chưa có giấy tờ bắt buộc nào).
      </div>
    );
  }
  const pct = Math.round(completion * 100);
  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 'var(--fs-sm)',
          marginBottom: 'var(--space-xs)',
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
          height: 'var(--space-sm)',
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Theo dõi giấy tờ/chứng chỉ của ứng viên. Bộ mặc định khởi tạo theo thị trường mong muốn
        {desiredMarket ? ` (${marketLabel(desiredMarket)})` : ' (chưa rõ → dùng bộ "Khác")'}.
      </div>

      <div className="row-actions" style={{ marginBottom: 'var(--space-md)' }}>
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
        <Loading variant="table" rows={4} label="Đang tải checklist…" />
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
                            style={{ color: 'var(--success)', marginRight: 'var(--space-xs)' }}
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
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
                            style={{ width: 'auto', height: 'var(--space-xl)', padding: 'var(--space-xs) var(--space-sm)' }}
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

          <h3 style={{ fontSize: 'var(--fs-h3)', margin: '0 0 var(--space-sm)' }}>Thêm loại giấy tờ</h3>
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
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Đối chiếu hồ sơ ứng viên với cơ sở dữ liệu chương trình XKLĐ và xếp hạng theo độ phù hợp
        (đủ điều kiện ưu tiên trước, kèm lý do nếu chưa đạt).
      </div>
      <button className="btn btn--secondary btn-sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Đang đối chiếu…' : 'Gợi ý điểm đến'}
      </button>
      {mutation.error != null && <div style={{ marginTop: 'var(--space-md)' }}><ErrorMessage error={mutation.error} /></div>}

      {suggestions != null && (
        <div style={{ marginTop: 'var(--space-md)' }}>
          {suggestions.length === 0 ? (
            <Empty label="Chưa tìm thấy chương trình phù hợp. Hãy bổ sung dữ liệu điểm đến hoặc nguyện vọng ứng viên." />
          ) : (
            <div className="steps-list">
              {suggestions.map((s) => (
                <div key={s.programId} className="step-row" style={{ alignItems: 'flex-start' }}>
                  <div className="step-index" style={{ background: s.eligible ? 'var(--success)' : 'var(--stone-300)' }}>
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
                      <div className="muted" style={{ marginTop: 'var(--space-xs)', fontSize: 'var(--fs-xs)' }}>
                        ✓ {s.matched.join(' · ')}
                      </div>
                    )}
                    {s.blockers.length > 0 && (
                      <div style={{ marginTop: 'var(--space-xs)', fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
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
        <div style={{ marginTop: 'var(--space-md)' }}>
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
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-md)', marginBottom: 'var(--space-sm)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
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
        <pre className="code" style={{ whiteSpace: 'pre-wrap', marginTop: 'var(--space-sm)' }}>{advice}</pre>
      )}

      {visaCase.logistics && (
        <div className="success-box" style={{ marginTop: 'var(--space-sm)', whiteSpace: 'pre-wrap' }}>
          <strong>Hậu cần:</strong> Bảo hiểm {visaCase.logistics.insuranceType || '—'} · Chỗ ở{' '}
          {visaCase.logistics.housingType || '—'}
          {visaCase.logistics.notes ? `\n${visaCase.logistics.notes}` : ''}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 'var(--space-sm)' }}>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                      <span className={`badge ${VISA_TASK_STATUS_BADGE[t.status]}`}>
                        {VISA_TASK_STATUS_LABEL[t.status]}
                      </span>
                      <select
                        value={t.status}
                        disabled={taskStatusMutation.isPending}
                        onChange={(e) => taskStatusMutation.mutate({ taskId: t.id, status: e.target.value })}
                        style={{ width: 'auto', height: 'var(--space-xl)', padding: 'var(--space-xs) var(--space-sm)' }}
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
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
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
      {mutation.error != null && <div style={{ marginTop: 'var(--space-md)' }}><ErrorMessage error={mutation.error} /></div>}

      {results != null && (
        <div style={{ marginTop: 'var(--space-md)' }}>
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
                        <div style={{ fontWeight: 'var(--fw-semibold)' }}>{r.name}</div>
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

// ---- Admissions — Reach/Match/Safety (Nhóm 1) ------------------------------
//
// Academic-profile form (gpa/gpaScale/ielts/toefl/jlpt/educationLevel) +
// admission scoring across the active program catalogue, grouped by band
// (REACH/MATCH/SAFETY). Scores render as a percentage when numeric and as
// "Chưa đủ dữ liệu" when the backend returns 'INSUFFICIENT_DATA'. Gap
// suggestions cite the program's own published thresholds (never fabricated).

/** Render a [0,1] metric as a whole percentage, or the missing-data label. */
function formatScorePct(score: NumericOrInsufficient): string {
  if (score === 'INSUFFICIENT_DATA') return 'Chưa đủ dữ liệu';
  return `${Math.round(score * 100)}%`;
}

const ADMISSION_BAND_ORDER: Array<'SAFETY' | 'MATCH' | 'REACH'> = ['SAFETY', 'MATCH', 'REACH'];

const ADMISSION_BAND_LABEL: Record<'SAFETY' | 'MATCH' | 'REACH', string> = {
  SAFETY: 'An toàn (Safety)',
  MATCH: 'Phù hợp (Match)',
  REACH: 'Khó (Reach)',
};

const ADMISSION_BAND_BADGE: Record<'SAFETY' | 'MATCH' | 'REACH', string> = {
  SAFETY: 'badge-green',
  MATCH: 'badge-blue',
  REACH: 'badge-yellow',
};

const ADMISSION_GAP_LABEL: Record<'GPA' | 'IELTS' | 'TOEFL' | 'JLPT', string> = {
  GPA: 'GPA',
  IELTS: 'IELTS',
  TOEFL: 'TOEFL',
  JLPT: 'JLPT',
};

function AdmissionsPanel({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const profileKey = ['admissions', 'academic', candidateId] as const;

  const [gpa, setGpa] = useState('');
  const [gpaScale, setGpaScale] = useState('10');
  const [ielts, setIelts] = useState('');
  const [toefl, setToefl] = useState('');
  const [jlpt, setJlpt] = useState('');
  const [educationLevel, setEducationLevel] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<AdmissionResult[] | null>(null);

  const profileQuery = useQuery({
    queryKey: profileKey,
    queryFn: () => getAcademicProfile(candidateId),
    enabled: candidateId.length > 0,
  });

  // Seed the form once from the persisted profile (then leave it user-editable).
  const profile = profileQuery.data;
  if (profile && !seeded) {
    setGpa(profile.gpa != null ? String(profile.gpa) : '');
    setGpaScale(profile.gpaScale != null ? String(profile.gpaScale) : '10');
    setIelts(profile.ielts != null ? String(profile.ielts) : '');
    setToefl(profile.toefl != null ? String(profile.toefl) : '');
    setJlpt(profile.jlpt ?? '');
    setEducationLevel(profile.educationLevel ?? '');
    setSeeded(true);
  }

  function toNum(v: string): number | undefined {
    const t = v.trim();
    if (t.length === 0) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: AcademicProfileInput = {
        gpa: toNum(gpa) ?? null,
        gpaScale: toNum(gpaScale) ?? null,
        ielts: toNum(ielts) ?? null,
        toefl: toNum(toefl) ?? null,
        jlpt: jlpt.trim() || null,
        educationLevel: educationLevel.trim() || null,
      };
      return putAcademicProfile(candidateId, body);
    },
    onSuccess: () => {
      setMessage('Đã lưu hồ sơ học thuật.');
      void queryClient.invalidateQueries({ queryKey: profileKey });
    },
  });

  const scoreMutation = useMutation({
    mutationFn: () => scoreAdmissions(candidateId),
    onSuccess: (res) => setResults(res),
  });

  const grouped = ADMISSION_BAND_ORDER.map((band) => ({
    band,
    items: (results ?? []).filter((r) => r.band === band),
  }));
  const insufficient = (results ?? []).filter((r) => r.band === 'INSUFFICIENT_DATA');

  return (
    <div className="card">
      <h2 className="card-title">Khả năng trúng tuyển (Reach/Match/Safety)</h2>
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Nhập tín hiệu học thuật rồi chấm khả năng trúng tuyển trên toàn bộ danh mục chương trình.
        Hệ thống phân loại REACH/MATCH/SAFETY kèm gợi ý lấp khoảng cách lấy từ ngưỡng của chương
        trình; hiển thị "Chưa đủ dữ liệu" khi thiếu dữ liệu.
      </div>

      {message && <SuccessMessage>{message}</SuccessMessage>}
      {saveMutation.error != null && <ErrorMessage error={saveMutation.error} />}

      {profileQuery.isLoading ? (
        <Loading label="Đang tải hồ sơ học thuật…" />
      ) : (
        <>
          <div className="grid grid-2">
            <div className="field">
              <label>GPA</label>
              <input type="number" step="0.1" value={gpa} onChange={(e) => setGpa(e.target.value)} placeholder="VD: 8.0" />
            </div>
            <div className="field">
              <label>Thang GPA</label>
              <input type="number" step="0.1" value={gpaScale} onChange={(e) => setGpaScale(e.target.value)} placeholder="VD: 10" />
            </div>
            <div className="field">
              <label>IELTS</label>
              <input type="number" step="0.5" value={ielts} onChange={(e) => setIelts(e.target.value)} placeholder="VD: 6.5" />
            </div>
            <div className="field">
              <label>TOEFL</label>
              <input type="number" step="1" value={toefl} onChange={(e) => setToefl(e.target.value)} placeholder="VD: 90" />
            </div>
            <div className="field">
              <label>JLPT</label>
              <select value={jlpt} onChange={(e) => setJlpt(e.target.value)}>
                <option value="">— Không —</option>
                {['N5', 'N4', 'N3', 'N2', 'N1'].map((lv) => (
                  <option key={lv} value={lv}>{lv}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Trình độ học vấn</label>
              <input value={educationLevel} onChange={(e) => setEducationLevel(e.target.value)} placeholder="VD: Cử nhân" />
            </div>
          </div>

          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={saveMutation.isPending}
              onClick={() => {
                setMessage(null);
                saveMutation.mutate();
              }}
            >
              {saveMutation.isPending ? 'Đang lưu…' : 'Lưu hồ sơ học thuật'}
            </button>
            <button
              className="btn btn--secondary btn-sm"
              disabled={scoreMutation.isPending}
              onClick={() => scoreMutation.mutate()}
            >
              {scoreMutation.isPending ? 'Đang chấm…' : 'Chấm khả năng trúng tuyển'}
            </button>
          </div>
        </>
      )}

      {scoreMutation.error != null && <div style={{ marginTop: 'var(--space-md)' }}><ErrorMessage error={scoreMutation.error} /></div>}

      {results != null && (
        <div style={{ marginTop: 'var(--space-md)' }}>
          {results.length === 0 ? (
            <Empty label="Chưa có chương trình nào để chấm. Hãy bổ sung danh mục chương trình đích." />
          ) : (
            <>
              {grouped.map(({ band, items }) =>
                items.length === 0 ? null : (
                  <div key={band} style={{ marginBottom: 'var(--space-md)' }}>
                    <div style={{ marginBottom: 'var(--space-xs)' }}>
                      <span className={`badge ${ADMISSION_BAND_BADGE[band]}`}>{ADMISSION_BAND_LABEL[band]}</span>
                    </div>
                    <div className="steps-list">
                      {items.map((r) => (
                        <AdmissionResultRow key={r.programId} result={r} />
                      ))}
                    </div>
                  </div>
                ),
              )}
              {insufficient.length > 0 && (
                <div style={{ marginBottom: 'var(--space-xs)' }}>
                  <div style={{ marginBottom: 'var(--space-xs)' }}>
                    <span className="badge badge-gray">Chưa đủ dữ liệu</span>
                  </div>
                  <div className="steps-list">
                    {insufficient.map((r) => (
                      <AdmissionResultRow key={r.programId} result={r} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AdmissionResultRow({ result }: { result: AdmissionResult }) {
  return (
    <div className="step-row" style={{ alignItems: 'flex-start' }}>
      <div className="step-index">{formatScorePct(result.score)}</div>
      <div style={{ flex: 1 }}>
        <div>
          <strong>{result.name}</strong> <span className="muted">· {SUGG_MARKET_LABEL[result.country] ?? result.country}</span>
        </div>
        {result.gaps === 'INSUFFICIENT_DATA' ? (
          <div className="muted" style={{ marginTop: 'var(--space-xs)', fontSize: 'var(--fs-xs)' }}>
            Gợi ý cải thiện: Chưa đủ dữ liệu
          </div>
        ) : result.gaps.length > 0 ? (
          <ul style={{ marginTop: 'var(--space-xs)', marginBottom: 0, paddingLeft: 'var(--space-md)', fontSize: 'var(--fs-xs)' }}>
            {result.gaps.map((g) => (
              <li key={g.dimension}>
                {ADMISSION_GAP_LABEL[g.dimension]}: cần đạt <strong>{g.target}</strong>
                {g.current != null ? ` (hiện tại ${g.current})` : ' (chưa có)'}
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted" style={{ marginTop: 'var(--space-xs)', fontSize: 'var(--fs-xs)' }}>
            ✓ Đã đạt các ngưỡng công bố
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Essays — SOP / Motivation / CV drafts (Nhóm 2) ------------------------
//
// Create-draft control (docType + mode AI|STRUCTURED), a list of drafts with a
// REVIEW MODE status badge + AiGroundingBadge, a rubric review (score +
// feedback), and the guarded transition buttons (DRAFT→IN_REVIEW→APPROVED /
// ARCHIVED). The server rejects illegal transitions with 409.

const ESSAY_DOC_TYPE_LABEL: Record<EssayDocType, string> = {
  SOP: 'SOP (Statement of Purpose)',
  MOTIVATION: 'Thư động lực',
  CV: 'CV',
};

const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  DRAFT: 'Bản nháp',
  IN_REVIEW: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  ARCHIVED: 'Lưu trữ',
};

const REVIEW_STATUS_BADGE: Record<ReviewStatus, string> = {
  DRAFT: 'badge-gray',
  IN_REVIEW: 'badge-yellow',
  APPROVED: 'badge-green',
  ARCHIVED: 'badge-gray',
};

/** Legal REVIEW MODE next-steps (mirrors the backend essay state machine). */
function allowedReviewTransitions(status: ReviewStatus): ReviewStatus[] {
  switch (status) {
    case 'DRAFT':
      return ['IN_REVIEW', 'ARCHIVED'];
    case 'IN_REVIEW':
      return ['APPROVED', 'ARCHIVED'];
    default:
      return [];
  }
}

function EssaysPanel({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const essaysKey = ['essays', candidateId] as const;

  const [docType, setDocType] = useState<EssayDocType>('SOP');
  const [mode, setMode] = useState<EssayGenMode>('AI');
  const [programId, setProgramId] = useState('');

  const essaysQuery = useQuery({
    queryKey: essaysKey,
    queryFn: () => listEssays(candidateId),
    enabled: candidateId.length > 0,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createEssay(candidateId, {
        docType,
        mode,
        programId: programId.trim() || undefined,
      }),
    onSuccess: () => {
      setProgramId('');
      void queryClient.invalidateQueries({ queryKey: essaysKey });
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Bản nháp SOP / Thư động lực / CV</h2>
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Tạo bản nháp bám theo hồ sơ và chương trình mục tiêu (chọn chế độ sinh bằng AI hoặc có cấu
        trúc xác định), chấm theo rubric, và duyệt theo REVIEW MODE. Khi chưa cấu hình AI, bản nháp
        vẫn được tạo từ dữ liệu nền (không phải lỗi).
      </div>

      <div className="toolbar">
        <div className="field">
          <label>Loại văn bản</label>
          <select value={docType} onChange={(e) => setDocType(e.target.value as EssayDocType)}>
            {(['SOP', 'MOTIVATION', 'CV'] as EssayDocType[]).map((d) => (
              <option key={d} value={d}>{ESSAY_DOC_TYPE_LABEL[d]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Chế độ sinh</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as EssayGenMode)}>
            <option value="AI">AI (Gemini nếu có)</option>
            <option value="STRUCTURED">Có cấu trúc (xác định)</option>
          </select>
        </div>
        <div className="field">
          <label>Mã chương trình (tùy chọn)</label>
          <input value={programId} onChange={(e) => setProgramId(e.target.value)} placeholder="programId" />
        </div>
        <button className="btn btn-primary btn-sm" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          <Icon name="plus" size={16} /> {createMutation.isPending ? 'Đang tạo…' : 'Tạo bản nháp'}
        </button>
      </div>
      {createMutation.error != null && <ErrorMessage error={createMutation.error} />}

      {essaysQuery.isLoading ? (
        <Loading label="Đang tải bản nháp…" />
      ) : essaysQuery.error ? (
        <ErrorMessage error={essaysQuery.error} />
      ) : essaysQuery.data && essaysQuery.data.length > 0 ? (
        <div style={{ marginTop: 'var(--space-md)' }}>
          {essaysQuery.data.map((essay) => (
            <EssayCard
              key={essay.id}
              candidateId={candidateId}
              essay={essay}
              onChanged={() => queryClient.invalidateQueries({ queryKey: essaysKey })}
            />
          ))}
        </div>
      ) : (
        <Empty label="Chưa có bản nháp nào. Tạo một bản nháp ở trên." />
      )}
    </div>
  );
}

function EssayCard({
  candidateId,
  essay,
  onChanged,
}: {
  candidateId: string;
  essay: import('../api/studyAdvisor').EssayDraft;
  onChanged: () => void;
}) {
  const [review, setReview] = useState<EssayReview | null>(null);

  const reviewMutation = useMutation({
    mutationFn: () => reviewEssay(candidateId, essay.id),
    onSuccess: (res) => setReview(res),
  });

  const transitionMutation = useMutation({
    mutationFn: (target: ReviewStatus) => transitionEssay(candidateId, essay.id, target),
    onSuccess: () => onChanged(),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteEssay(candidateId, essay.id),
    onSuccess: () => onChanged(),
  });

  const nextSteps = allowedReviewTransitions(essay.status);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-md)', marginBottom: 'var(--space-sm)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
          <strong>{ESSAY_DOC_TYPE_LABEL[essay.docType]}</strong>
          <span className={`badge ${REVIEW_STATUS_BADGE[essay.status]}`}>{REVIEW_STATUS_LABEL[essay.status]}</span>
          <AiGroundingBadge aiGenerated={essay.aiGenerated} />
        </div>
        <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{formatDate(essay.createdAt)}</div>
      </div>

      <pre className="code" style={{ whiteSpace: 'pre-wrap', marginTop: 'var(--space-sm)', maxHeight: 220, overflow: 'auto' }}>
        {essay.content}
      </pre>

      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-xs)', marginTop: 'var(--space-sm)' }}>
        <button className="btn btn-sm" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate()}>
          <Icon name="sparkles" size={14} /> {reviewMutation.isPending ? 'Đang chấm…' : 'Chấm điểm'}
        </button>
        {nextSteps.map((target) => (
          <button
            key={target}
            className="btn btn-sm"
            disabled={transitionMutation.isPending}
            onClick={() => transitionMutation.mutate(target)}
          >
            → {REVIEW_STATUS_LABEL[target]}
          </button>
        ))}
        <button
          className="btn btn-danger btn-sm"
          disabled={deleteMutation.isPending}
          onClick={() => deleteMutation.mutate()}
        >
          {deleteMutation.isPending ? 'Đang xóa…' : 'Xóa'}
        </button>
      </div>

      {reviewMutation.error != null && <div style={{ marginTop: 'var(--space-sm)' }}><ErrorMessage error={reviewMutation.error} /></div>}
      {transitionMutation.error != null && <div style={{ marginTop: 'var(--space-sm)' }}><ErrorMessage error={transitionMutation.error} /></div>}
      {deleteMutation.error != null && <div style={{ marginTop: 'var(--space-sm)' }}><ErrorMessage error={deleteMutation.error} /></div>}

      {review != null && (
        <div style={{ marginTop: 'var(--space-sm)' }}>
          <div style={{ marginBottom: 'var(--space-xs)' }}>
            Điểm rubric: <strong>{Math.round(review.score * 100)}%</strong>
          </div>
          {review.feedback.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 'var(--space-md)', fontSize: 'var(--fs-sm)' }}>
              {review.feedback.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : (
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Không có phản hồi bổ sung.</div>
          )}
        </div>
      )}

      {essay.status === 'APPROVED' && (
        <div className="muted" style={{ marginTop: 'var(--space-sm)', fontSize: 'var(--fs-xs)' }}>
          Đã duyệt{essay.approvedAt ? ` · ${formatDate(essay.approvedAt)}` : ''} (vẫn cần các bước gửi đi để
          coi là chính thức).
        </div>
      )}
    </div>
  );
}

// ---- Timeline — merged application/visa due items (Nhóm 4) -----------------
//
// Create an ApplicationCase (program optional, intake label + target date +
// country) and view the merged timeline across all application/visa cases,
// ordered by dueAt ascending with undated items last. The next due item is
// highlighted from the backend's nextDue.

function TimelinePanel({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const casesKey = ['applications', 'cases', candidateId] as const;
  const timelineKey = ['applications', 'timeline', candidateId] as const;

  const [programId, setProgramId] = useState('');
  const [intakeLabel, setIntakeLabel] = useState('');
  const [targetIntakeDate, setTargetIntakeDate] = useState('');
  const [country, setCountry] = useState('');

  const casesQuery = useQuery({
    queryKey: casesKey,
    queryFn: () => listApplications(candidateId),
    enabled: candidateId.length > 0,
  });

  const timelineQuery = useQuery({
    queryKey: timelineKey,
    queryFn: () => getTimeline(candidateId),
    enabled: candidateId.length > 0,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createApplication(candidateId, {
        programId: programId.trim() || undefined,
        intakeLabel: intakeLabel.trim(),
        targetIntakeDate: targetIntakeDate || undefined,
        country: country.trim() || undefined,
      }),
    onSuccess: () => {
      setProgramId('');
      setIntakeLabel('');
      setTargetIntakeDate('');
      setCountry('');
      void queryClient.invalidateQueries({ queryKey: casesKey });
      void queryClient.invalidateQueries({ queryKey: timelineKey });
    },
  });

  const nextDueId = timelineQuery.data?.nextDue?.id ?? null;

  return (
    <div className="card">
      <h2 className="card-title">Dòng thời gian hồ sơ</h2>
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Tạo đơn ứng tuyển (kèm đợt nhập học) và xem dòng thời gian gộp mọi hồ sơ ứng tuyển + visa,
        sắp theo hạn tăng dần (việc chưa có hạn xếp cuối). Việc đến hạn tiếp theo được đánh dấu.
      </div>

      <div className="toolbar">
        <div className="field">
          <label>Đợt nhập học</label>
          <input value={intakeLabel} onChange={(e) => setIntakeLabel(e.target.value)} placeholder="VD: Fall 2025" />
        </div>
        <div className="field">
          <label>Quốc gia (tùy chọn)</label>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">— Theo chương trình —</option>
            {VISA_COUNTRIES.map((c) => (
              <option key={c} value={c}>{SUGG_MARKET_LABEL[c] ?? c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Mã chương trình (tùy chọn)</label>
          <input value={programId} onChange={(e) => setProgramId(e.target.value)} placeholder="programId" />
        </div>
        <div className="field">
          <label>Ngày nhập học (dự kiến)</label>
          <input type="date" value={targetIntakeDate} onChange={(e) => setTargetIntakeDate(e.target.value)} />
        </div>
        <button
          className="btn btn-primary btn-sm"
          disabled={createMutation.isPending || intakeLabel.trim().length === 0}
          onClick={() => createMutation.mutate()}
        >
          <Icon name="plus" size={16} /> {createMutation.isPending ? 'Đang tạo…' : 'Tạo đơn ứng tuyển'}
        </button>
      </div>
      {createMutation.error != null && <ErrorMessage error={createMutation.error} />}

      {casesQuery.data && (
        <div className="muted" style={{ marginTop: 'var(--space-xs)', marginBottom: 'var(--space-xs)', fontSize: 'var(--fs-xs)' }}>
          {casesQuery.data.total} đơn ứng tuyển
        </div>
      )}

      <div style={{ marginTop: 'var(--space-md)' }}>
        {timelineQuery.isLoading ? (
          <Loading variant="table" rows={5} label="Đang tải dòng thời gian…" />
        ) : timelineQuery.error ? (
          <ErrorMessage error={timelineQuery.error} />
        ) : timelineQuery.data && timelineQuery.data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Việc</th>
                  <th>Loại</th>
                  <th>Hạn</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {timelineQuery.data.items.map((item) => {
                  const isNext = item.id === nextDueId;
                  return (
                    <tr
                      key={item.id}
                      style={isNext ? { background: 'var(--color-gold-soft)' } : undefined}
                    >
                      <td style={{ whiteSpace: 'normal' }}>
                        {item.label}{' '}
                        {isNext && <span className="badge badge-yellow">Sắp đến hạn tiếp theo</span>}
                      </td>
                      <td>
                        <span className="badge badge-gray">
                          {item.caseType === 'VISA' ? 'Visa' : 'Ứng tuyển'}
                        </span>
                      </td>
                      <td>{item.dueAt ? formatDate(item.dueAt) : 'Chưa xác định'}</td>
                      <td>
                        {item.done ? (
                          <span className="badge badge-green">Hoàn tất</span>
                        ) : (
                          <span className="badge badge-gray">Chưa xong</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty label="Chưa có việc nào trên dòng thời gian. Tạo một đơn ứng tuyển hoặc hồ sơ visa." />
        )}
      </div>
    </div>
  );
}

// ---- Roadmap — ROI + readiness + REVIEW MODE narrative (Nhóm 5) ------------
//
// A program input drives the ROI estimate (net cost / total / ROI, surfacing
// "Chưa đủ dữ liệu" for INSUFFICIENT_DATA, plus grounded career/PR notes), a
// readiness display (score + grounded gaps), and a create+transition roadmap
// narrative control (REVIEW MODE) with the AiGroundingBadge.

function RoadmapPanel({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const readinessKey = ['roadmap', 'readiness', candidateId] as const;

  const [programId, setProgramId] = useState('');
  const [estimate, setEstimate] = useState<RoadmapEstimate | null>(null);
  const [narrativeMode, setNarrativeMode] = useState<EssayGenMode>('AI');
  const [narrative, setNarrative] = useState<import('../api/studyAdvisor').RoadmapNarrative | null>(null);

  const readinessQuery = useQuery({
    queryKey: readinessKey,
    queryFn: () => getReadiness(candidateId, programId.trim() || undefined),
    enabled: candidateId.length > 0,
  });

  const estimateMutation = useMutation({
    mutationFn: () => estimateRoadmap(candidateId, programId.trim()),
    onSuccess: (res) => setEstimate(res),
  });

  const narrativeMutation = useMutation({
    mutationFn: () =>
      createRoadmapNarrative(candidateId, { programId: programId.trim(), mode: narrativeMode }),
    onSuccess: (res) => setNarrative(res),
  });

  const transitionMutation = useMutation({
    mutationFn: (target: ReviewStatus) =>
      transitionRoadmapNarrative(candidateId, narrative!.id, target),
    onSuccess: (res) => setNarrative(res),
  });

  const programReady = programId.trim().length > 0;
  const nextSteps = narrative ? allowedReviewTransitions(narrative.status) : [];

  function formatVndM(v: NumericOrInsufficient): string {
    return v === 'INSUFFICIENT_DATA' ? 'Chưa đủ dữ liệu' : `${v} tr`;
  }

  function formatRoi(v: NumericOrInsufficient): string {
    return v === 'INSUFFICIENT_DATA' ? 'Chưa đủ dữ liệu' : v.toFixed(2);
  }

  return (
    <div className="card">
      <h2 className="card-title">Lộ trình ROI &amp; Sẵn sàng hồ sơ</h2>
      <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
        Ước tính chi phí ròng/tổng/ROI (chi phí ròng tái dùng module học bổng) cùng ghi chú nghề
        nghiệp/định cư có căn cứ, điểm sẵn sàng hồ sơ + gợi ý lấp khoảng cách, và bản tường thuật lộ
        trình theo REVIEW MODE. Hiển thị "Chưa đủ dữ liệu" khi thiếu dữ liệu tài chính.
      </div>

      <div className="field">
        <label>Mã chương trình</label>
        <input value={programId} onChange={(e) => setProgramId(e.target.value)} placeholder="programId" />
      </div>

      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <button
          className="btn btn--secondary btn-sm"
          disabled={!programReady || estimateMutation.isPending}
          onClick={() => estimateMutation.mutate()}
        >
          {estimateMutation.isPending ? 'Đang ước tính…' : 'Ước tính ROI'}
        </button>
        <button
          className="btn btn-sm"
          disabled={readinessQuery.isFetching}
          onClick={() => queryClient.invalidateQueries({ queryKey: readinessKey })}
        >
          {readinessQuery.isFetching ? 'Đang chấm…' : 'Tính điểm sẵn sàng'}
        </button>
      </div>

      {estimateMutation.error != null && <div style={{ marginTop: 'var(--space-md)' }}><ErrorMessage error={estimateMutation.error} /></div>}

      {estimate != null && (
        <div style={{ marginTop: 'var(--space-md)' }}>
          <div className="grid grid-2">
            <StatCard label="Chi phí ròng/năm" value={formatVndM(estimate.netCostPerYearVndM)} />
            <StatCard label="Tổng chi phí" value={formatVndM(estimate.totalCostVndM)} />
            <StatCard label="ROI (ước tính)" value={formatRoi(estimate.roi)} />
          </div>
          {estimate.careerNotes.length > 0 && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <strong style={{ fontSize: 'var(--fs-sm)' }}>Ghi chú nghề nghiệp</strong>
              <ul style={{ margin: 'var(--space-xs) 0 0', paddingLeft: 'var(--space-md)', fontSize: 'var(--fs-sm)' }}>
                {estimate.careerNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {estimate.prPathwayNotes.length > 0 && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <strong style={{ fontSize: 'var(--fs-sm)' }}>Ghi chú lộ trình định cư</strong>
              <ul style={{ margin: 'var(--space-xs) 0 0', paddingLeft: 'var(--space-md)', fontSize: 'var(--fs-sm)' }}>
                {estimate.prPathwayNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="divider" />

      <h3 style={{ fontSize: 'var(--fs-h3)', margin: '0 0 var(--space-sm)' }}>Điểm sẵn sàng hồ sơ</h3>
      {readinessQuery.isLoading ? (
        <Loading label="Đang tính điểm sẵn sàng…" />
      ) : readinessQuery.error ? (
        <ErrorMessage error={readinessQuery.error} />
      ) : readinessQuery.data ? (
        <div>
          <div style={{ marginBottom: 'var(--space-xs)' }}>
            Điểm sẵn sàng: <strong>{formatScorePct(readinessQuery.data.score)}</strong>
          </div>
          {readinessQuery.data.gaps.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 'var(--space-md)', fontSize: 'var(--fs-sm)' }}>
              {readinessQuery.data.gaps.map((g) => (
                <li key={g.dimension}>
                  {ADMISSION_GAP_LABEL[g.dimension]}: cần đạt <strong>{g.target}</strong>
                  {g.current != null ? ` (hiện tại ${g.current})` : ' (chưa có)'}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Không có khoảng cách cần lấp.</div>
          )}
        </div>
      ) : null}

      <div className="divider" />

      <h3 style={{ fontSize: 'var(--fs-h3)', margin: '0 0 var(--space-sm)' }}>Bản tường thuật lộ trình (REVIEW MODE)</h3>
      <div className="toolbar">
        <div className="field">
          <label>Chế độ sinh</label>
          <select value={narrativeMode} onChange={(e) => setNarrativeMode(e.target.value as EssayGenMode)}>
            <option value="AI">AI (Gemini nếu có)</option>
            <option value="STRUCTURED">Có cấu trúc (xác định)</option>
          </select>
        </div>
        <button
          className="btn btn-primary btn-sm"
          disabled={!programReady || narrativeMutation.isPending}
          onClick={() => narrativeMutation.mutate()}
        >
          {narrativeMutation.isPending ? 'Đang soạn…' : 'Tạo bản tường thuật'}
        </button>
      </div>
      {narrativeMutation.error != null && <ErrorMessage error={narrativeMutation.error} />}

      {narrative != null && (
        <div style={{ marginTop: 'var(--space-md)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap', marginBottom: 'var(--space-sm)' }}>
            <span className={`badge ${REVIEW_STATUS_BADGE[narrative.status]}`}>{REVIEW_STATUS_LABEL[narrative.status]}</span>
            <AiGroundingBadge aiGenerated={narrative.aiGenerated} />
          </div>
          <pre className="code" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
            {narrative.narrative}
          </pre>
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-xs)', marginTop: 'var(--space-sm)' }}>
            {nextSteps.map((target) => (
              <button
                key={target}
                className="btn btn-sm"
                disabled={transitionMutation.isPending}
                onClick={() => transitionMutation.mutate(target)}
              >
                → {REVIEW_STATUS_LABEL[target]}
              </button>
            ))}
          </div>
          {transitionMutation.error != null && <div style={{ marginTop: 'var(--space-sm)' }}><ErrorMessage error={transitionMutation.error} /></div>}
        </div>
      )}
    </div>
  );
}
