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
  deleteCandidate,
  getCandidate,
  listJobOrders,
  matchCandidate,
  updateCandidate,
} from '../api/recruitment';
import { aiDraftOutreach, aiSuggestJobOrders } from '../api/aiConsultant';
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
    <div>
      <div className="page-header">
        <h1 className="page-title">Hồ sơ ứng viên</h1>
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
            <AiConsultPanel candidateId={id} />
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
            className="btn btn-primary btn-sm"
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
        className="btn btn-primary btn-sm"
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
