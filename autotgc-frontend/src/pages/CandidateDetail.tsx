/**
 * CandidateDetail (/candidates/:id) â€” full candidate profile + stage-history
 * timeline, with controls to:
 *   - advance the stage (PUT { stage }; only legal next stages are offered),
 *   - match the candidate to an OPEN job order (POST /match),
 *   - run the AI consultant panel: suggest ranked job orders and draft an
 *     outreach message for this candidate.
 *
 * AI grounding note: the suggest/draft endpoints return `aiGenerated`. When it
 * is false the result is a deterministic, knowledge-grounded answer (no Gemini
 * call) â€” we surface this clearly as "Tráº£ lá»i dá»±a trÃªn cÆ¡ sá»Ÿ tri thá»©c", never
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
    if (window.confirm('XÃ³a á»©ng viÃªn nÃ y? HÃ nh Ä‘á»™ng khÃ´ng thá»ƒ hoÃ n tÃ¡c.')) {
      deleteMutation.mutate();
    }
  }

  if (id.length === 0) {
    return <Empty label="Thiáº¿u mÃ£ á»©ng viÃªn." />;
  }

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">CRM tuyá»ƒn dá»¥ng</div>
          <h1 className="page-title">Há»“ sÆ¡ á»©ng viÃªn</h1>
        </div>
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => navigate('/candidates')}>
            <Icon name="arrow-left" size={16} />
            Danh sÃ¡ch
          </button>
          {isAdmin && (
            <button
              className="btn btn-danger btn-sm"
              disabled={deleteMutation.isPending}
              onClick={confirmDelete}
            >
              XÃ³a
            </button>
          )}
        </div>
      </div>

      {deleteMutation.error != null && <ErrorMessage error={deleteMutation.error} />}

      {candidateQuery.isLoading ? (
        <Loading label="Äang táº£iâ€¦" />
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
            <DocumentChecklistPanel candidateId={id} desiredMarket={candidateQuery.data.desiredMarket} />
          </div>
        </div>
      ) : (
        <Empty label="KhÃ´ng tÃ¬m tháº¥y á»©ng viÃªn." />
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
        <dt>Äiá»‡n thoáº¡i</dt>
        <dd>{candidate.phone ?? 'â€”'}</dd>
        <dt>Email</dt>
        <dd>{candidate.email ?? 'â€”'}</dd>
        <dt>NgÃ y sinh</dt>
        <dd>{candidate.dob ? formatDate(candidate.dob) : 'â€”'}</dd>
        <dt>Giá»›i tÃ­nh</dt>
        <dd>{candidate.gender || 'â€”'}</dd>
        <dt>QuÃª quÃ¡n</dt>
        <dd>{candidate.hometown || 'â€”'}</dd>
        <dt>Há»c váº¥n</dt>
        <dd>{candidate.education || 'â€”'}</dd>
        <dt>CÃ´ng viá»‡c hiá»‡n táº¡i</dt>
        <dd>{candidate.currentJob || 'â€”'}</dd>
        <dt>Thá»‹ trÆ°á»ng mong muá»‘n</dt>
        <dd>{marketLabel(candidate.desiredMarket)}</dd>
        <dt>Diá»‡n visa mong muá»‘n</dt>
        <dd>{visaTypeLabel(candidate.desiredVisaType)}</dd>
        <dt>NgÃ nh mong muá»‘n</dt>
        <dd>{candidate.desiredIndustry || 'â€”'}</dd>
        <dt>TrÃ¬nh Ä‘á»™ tiáº¿ng Nháº­t</dt>
        <dd>{candidate.japaneseLevel || 'â€”'}</dd>
        <dt>Ngoáº¡i ngá»¯ khÃ¡c</dt>
        <dd>{candidate.otherLanguage || 'â€”'}</dd>
        <dt>Nguá»“n</dt>
        <dd>{candidate.source || 'â€”'}</dd>
        <dt>NgÆ°á»i phá»¥ trÃ¡ch</dt>
        <dd>{candidate.assignedTo ?? 'â€”'}</dd>
        <dt>Ghi chÃº</dt>
        <dd>{candidate.note ?? 'â€”'}</dd>
        <dt>NgÃ y táº¡o</dt>
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
      setMessage(`ÄÃ£ chuyá»ƒn sang giai Ä‘oáº¡n "${candidateStageLabel(target)}".`);
      setTarget('');
      setNote('');
      onChanged();
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">Chuyá»ƒn giai Ä‘oáº¡n</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Giai Ä‘oáº¡n hiá»‡n táº¡i: <strong>{candidateStageLabel(currentStage)}</strong>. Há»‡ thá»‘ng chá»‰ cho
        phÃ©p cÃ¡c bÆ°á»›c há»£p lá»‡ (server tá»« chá»‘i bÆ°á»›c sai vá»›i mÃ£ 409).
      </div>
      {message && <SuccessMessage>{message}</SuccessMessage>}
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {nextStages.length === 0 ? (
        <div className="muted">ÄÃ¢y lÃ  giai Ä‘oáº¡n káº¿t thÃºc â€” khÃ´ng thá»ƒ chuyá»ƒn tiáº¿p.</div>
      ) : (
        <>
          <div className="field">
            <label>Giai Ä‘oáº¡n má»›i</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">â€” Chá»n â€”</option>
              {nextStages.map((s) => (
                <option key={s} value={s}>
                  {candidateStageLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Ghi chÃº (tÃ¹y chá»n)</label>
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
            {mutation.isPending ? 'Äang chuyá»ƒnâ€¦' : 'Chuyá»ƒn giai Ä‘oáº¡n'}
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
      setMessage('ÄÃ£ ghÃ©p á»©ng viÃªn vá»›i Ä‘Æ¡n hÃ ng (giai Ä‘oáº¡n chuyá»ƒn sang ÄÃ£ ghÃ©p Ä‘Æ¡n).');
      setSelected('');
      onMatched();
    },
  });

  return (
    <div className="card">
      <h2 className="card-title">GhÃ©p Ä‘Æ¡n hÃ ng</h2>
      {matchedJobOrderId && (
        <div className="muted" style={{ marginBottom: 10 }}>
          ÄÆ¡n hÃ ng Ä‘Ã£ ghÃ©p hiá»‡n táº¡i: <code>{matchedJobOrderId}</code>
        </div>
      )}
      {message && <SuccessMessage>{message}</SuccessMessage>}
      {mutation.error != null && <ErrorMessage error={mutation.error} />}
      {openOrdersQuery.isLoading ? (
        <Loading label="Äang táº£i Ä‘Æ¡n hÃ ngâ€¦" />
      ) : openOrdersQuery.error ? (
        <ErrorMessage error={openOrdersQuery.error} />
      ) : openOrdersQuery.data && openOrdersQuery.data.items.length > 0 ? (
        <>
          <div className="field">
            <label>Chá»n Ä‘Æ¡n hÃ ng Ä‘ang tuyá»ƒn</label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">â€” Chá»n Ä‘Æ¡n hÃ ng â€”</option>
              {openOrdersQuery.data.items.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} â€” {o.title} ({marketLabel(o.market)})
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
            {mutation.isPending ? 'Äang ghÃ©pâ€¦' : 'GhÃ©p Ä‘Æ¡n hÃ ng'}
          </button>
        </>
      ) : (
        <Empty label="KhÃ´ng cÃ³ Ä‘Æ¡n hÃ ng nÃ o Ä‘ang tuyá»ƒn." />
      )}
    </div>
  );
}

function HistoryTimeline({ history }: { history: CandidateStageHistoryEntry[] }) {
  return (
    <div className="card">
      <h2 className="card-title">Lá»‹ch sá»­ giai Ä‘oáº¡n</h2>
      {history.length === 0 ? (
        <div className="muted">ChÆ°a cÃ³ thay Ä‘á»•i giai Ä‘oáº¡n nÃ o.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Thá»i Ä‘iá»ƒm</th>
                <th>Tá»« â†’ Äáº¿n</th>
                <th>Ghi chÃº</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{formatDate(h.changedAt)}</td>
                  <td>
                    {candidateStageLabel(h.previousStage)} â†’ {candidateStageLabel(h.newStage)}
                  </td>
                  <td>{h.note ?? 'â€”'}</td>
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
 * the answer). Works with no Gemini key â€” the backend returns a deterministic,
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
    'á»¨ng viÃªn nÃ y phÃ¹ há»£p Ä‘Æ¡n hÃ ng nÃ o?',
    'Cáº§n chuáº©n bá»‹ giáº¥y tá» gÃ¬ cho thá»‹ trÆ°á»ng mong muá»‘n?',
    'Lá»™ trÃ¬nh vÃ  chi phÃ­ dá»± kiáº¿n ra sao?',
  ];

  function ask(q: string) {
    const trimmed = q.trim();
    if (trimmed.length === 0 || askMutation.isPending) return;
    askMutation.mutate(trimmed);
  }

  return (
    <div className="card">
      <h2 className="card-title">Copilot tÆ° váº¥n</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Há»i nhanh vá» á»©ng viÃªn nÃ y â€” Copilot tráº£ lá»i dá»±a trÃªn cÆ¡ sá»Ÿ tri thá»©c vÃ  há»“ sÆ¡. Khi chÆ°a cáº¥u
        hÃ¬nh AI, cÃ¢u tráº£ lá»i váº«n bÃ¡m sÃ¡t dá»¯ liá»‡u ná»n (khÃ´ng pháº£i lá»—i).
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
        <label>CÃ¢u há»i</label>
        <textarea
          value={question}
          placeholder="VD: á»¨ng viÃªn 25 tuá»•i, tiáº¿ng Nháº­t N4 thÃ¬ Ä‘i Ä‘Æ°á»£c Ä‘Æ¡n hÃ ng nÃ o?"
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
        {askMutation.isPending ? 'Äang há»iâ€¦' : 'Há»i Copilot'}
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
      <h2 className="card-title">TÆ° váº¥n AI</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Gá»£i Ã½ Ä‘Æ¡n hÃ ng phÃ¹ há»£p vÃ  soáº¡n tin nháº¯n tiáº¿p cáº­n cho á»©ng viÃªn nÃ y. Khi chÆ°a cáº¥u hÃ¬nh AI, há»‡
        thá»‘ng váº«n tráº£ lá»i dá»±a trÃªn cÆ¡ sá»Ÿ tri thá»©c.
      </div>

      <button
        className="btn btn--secondary btn-sm"
        disabled={suggestMutation.isPending}
        onClick={() => suggestMutation.mutate()}
      >
        {suggestMutation.isPending ? 'Äang phÃ¢n tÃ­châ€¦' : 'Gá»£i Ã½ Ä‘Æ¡n hÃ ng phÃ¹ há»£p'}
      </button>

      {suggestMutation.error != null && (
        <div style={{ marginTop: 12 }}>
          <ErrorMessage error={suggestMutation.error} />
        </div>
      )}

      {suggestions != null && (
        <div style={{ marginTop: 14 }}>
          {suggestions.length === 0 ? (
            <Empty label="ChÆ°a tÃ¬m tháº¥y Ä‘Æ¡n hÃ ng phÃ¹ há»£p. HÃ£y bá»• sung nguyá»‡n vá»ng cho á»©ng viÃªn hoáº·c thÃªm Ä‘Æ¡n hÃ ng Ä‘ang tuyá»ƒn." />
          ) : (
            <div className="steps-list">
              {suggestions.map((s) => (
                <div key={s.jobOrderId} className="step-row" style={{ alignItems: 'flex-start' }}>
                  <div className="step-index">{s.score}</div>
                  <div style={{ flex: 1 }}>
                    <div>
                      <strong>{s.code}</strong> â€” {s.title}
                    </div>
                    {Array.isArray(s.reasons) && s.reasons.length > 0 && (
                      <div className="muted" style={{ marginTop: 4 }}>
                        {s.reasons.join(' Â· ')}
                      </div>
                    )}
                    <button
                      className="btn btn-sm"
                      style={{ marginTop: 6 }}
                      disabled={draftMutation.isPending}
                      onClick={() => draftMutation.mutate(s.jobOrderId)}
                    >
                      {draftMutation.isPending && outreachJobOrderId === s.jobOrderId
                        ? 'Äang soáº¡nâ€¦'
                        : 'Soáº¡n tin tiáº¿p cáº­n'}
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
            <strong>Tin nháº¯n tiáº¿p cáº­n</strong>
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
// progress bar (rendered as "ChÆ°a Ä‘á»§ dá»¯ liá»‡u" when the backend returns
// 'INSUFFICIENT_DATA'), a per-market seed button, an add-custom-type control,
// and a per-item submission-status control. Status changes update the cache
// optimistically and recompute the completion metric locally; the server stays
// authoritative and a rollback restores the previous state on error.

const DOC_STATUSES: DocSubmissionStatus[] = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'];

const DOC_STATUS_LABELS: Record<DocSubmissionStatus, string> = {
  PENDING: 'Chá» ná»™p',
  SUBMITTED: 'ÄÃ£ ná»™p',
  VERIFIED: 'ÄÃ£ xÃ¡c minh',
  REJECTED: 'Tá»« chá»‘i',
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
        Tiáº¿n Ä‘á»™ há»“ sÆ¡: <strong>ChÆ°a Ä‘á»§ dá»¯ liá»‡u</strong> (chÆ°a cÃ³ giáº¥y tá» báº¯t buá»™c nÃ o).
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
        <span className="muted">Tiáº¿n Ä‘á»™ hoÃ n thÃ nh há»“ sÆ¡ (giáº¥y tá» báº¯t buá»™c Ä‘Ã£ xÃ¡c minh)</span>
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
      setLabelError('Vui lÃ²ng nháº­p tÃªn loáº¡i giáº¥y tá».');
      return;
    }
    setLabelError(null);
    addMutation.mutate();
  }

  const data = documentsQuery.data;

  return (
    <div className="card">
      <h2 className="card-title">Checklist giáº¥y tá»</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Theo dÃµi giáº¥y tá»/chá»©ng chá»‰ cá»§a á»©ng viÃªn. Bá»™ máº·c Ä‘á»‹nh khá»Ÿi táº¡o theo thá»‹ trÆ°á»ng mong muá»‘n
        {desiredMarket ? ` (${marketLabel(desiredMarket)})` : ' (chÆ°a rÃµ â†’ dÃ¹ng bá»™ "KhÃ¡c")'}.
      </div>

      <div className="row-actions" style={{ marginBottom: 14 }}>
        <button
          className="btn btn--secondary btn-sm"
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? 'Äang khá»Ÿi táº¡oâ€¦' : 'Khá»Ÿi táº¡o theo thá»‹ trÆ°á»ng'}
        </button>
      </div>

      {initMutation.error != null && <ErrorMessage error={initMutation.error} />}

      {documentsQuery.isLoading ? (
        <Loading label="Äang táº£i checklistâ€¦" />
      ) : documentsQuery.error ? (
        <ErrorMessage error={documentsQuery.error} />
      ) : data ? (
        <>
          <CompletionBar completion={data.completion} />

          {statusMutation.error != null && <ErrorMessage error={statusMutation.error} />}

          {data.items.length === 0 ? (
            <Empty label='ChÆ°a cÃ³ giáº¥y tá» nÃ o. Báº¥m "Khá»Ÿi táº¡o theo thá»‹ trÆ°á»ng" hoáº·c thÃªm loáº¡i tÃ¹y biáº¿n bÃªn dÆ°á»›i.' />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Loáº¡i giáº¥y tá»</th>
                    <th>Báº¯t buá»™c</th>
                    <th>Nguá»“n</th>
                    <th>Tráº¡ng thÃ¡i</th>
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
                          <span className="badge badge-blue">Báº¯t buá»™c</span>
                        ) : (
                          <span className="badge badge-gray">TÃ¹y chá»n</span>
                        )}
                      </td>
                      <td>
                        <span className="badge badge-gray">
                          {item.source === 'DEFAULT' ? 'Máº·c Ä‘á»‹nh' : 'TÃ¹y biáº¿n'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={`badge ${DOC_STATUS_BADGE[item.status]}`}>
                            {DOC_STATUS_LABELS[item.status]}
                          </span>
                          <select
                            aria-label={`Tráº¡ng thÃ¡i: ${item.label}`}
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

          <h3 style={{ fontSize: 'var(--fs-h3)', margin: '0 0 10px' }}>ThÃªm loáº¡i giáº¥y tá»</h3>
          {labelError && <ErrorMessage error={labelError} />}
          {addMutation.error != null && <ErrorMessage error={addMutation.error} />}
          <div className="field">
            <label>TÃªn loáº¡i giáº¥y tá»</label>
            <input
              value={label}
              placeholder="VD: Giáº¥y xÃ¡c nháº­n kinh nghiá»‡m"
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
              Báº¯t buá»™c
            </label>
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={addMutation.isPending}
            onClick={submitCustom}
          >
            <Icon name="plus" size={16} />
            {addMutation.isPending ? 'Äang thÃªmâ€¦' : 'ThÃªm loáº¡i giáº¥y tá»'}
          </button>
        </>
      ) : (
        <Empty label="KhÃ´ng táº£i Ä‘Æ°á»£c checklist." />
      )}
    </div>
  );
}

// ---- Destination suggestions (Ä‘á»‘i chiáº¿u DB & gá»£i Ã½ cho tÆ° váº¥n) --------------

const SUGG_MARKET_LABEL: Record<string, string> = {
  JAPAN: 'Nháº­t Báº£n',
  KOREA: 'HÃ n Quá»‘c',
  GERMANY: 'Äá»©c',
  TAIWAN: 'ÄÃ i Loan',
  AUSTRALIA: 'Ãšc',
  USA: 'Má»¹',
  CANADA: 'Canada',
  UK: 'Anh',
  OTHER: 'KhÃ¡c',
};

function DestinationSuggestionsPanel({ candidateId }: { candidateId: string }) {
  const [suggestions, setSuggestions] = useState<DestinationSuggestion[] | null>(null);

  const mutation = useMutation({
    mutationFn: () => getDestinationSuggestions(candidateId),
    onSuccess: (res) => setSuggestions(res.suggestions),
  });

  return (
    <div className="card">
      <h2 className="card-title">Gá»£i Ã½ Ä‘iá»ƒm Ä‘áº¿n phÃ¹ há»£p</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Äá»‘i chiáº¿u há»“ sÆ¡ á»©ng viÃªn vá»›i cÆ¡ sá»Ÿ dá»¯ liá»‡u chÆ°Æ¡ng trÃ¬nh XKLÄ vÃ  xáº¿p háº¡ng theo Ä‘á»™ phÃ¹ há»£p
        (Ä‘á»§ Ä‘iá»u kiá»‡n Æ°u tiÃªn trÆ°á»›c, kÃ¨m lÃ½ do náº¿u chÆ°a Ä‘áº¡t).
      </div>
      <button className="btn btn--secondary btn-sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Äang Ä‘á»‘i chiáº¿uâ€¦' : 'Gá»£i Ã½ Ä‘iá»ƒm Ä‘áº¿n'}
      </button>
      {mutation.error != null && <div style={{ marginTop: 12 }}><ErrorMessage error={mutation.error} /></div>}

      {suggestions != null && (
        <div style={{ marginTop: 14 }}>
          {suggestions.length === 0 ? (
            <Empty label="ChÆ°a tÃ¬m tháº¥y chÆ°Æ¡ng trÃ¬nh phÃ¹ há»£p. HÃ£y bá»• sung dá»¯ liá»‡u Ä‘iá»ƒm Ä‘áº¿n hoáº·c nguyá»‡n vá»ng á»©ng viÃªn." />
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
                      <span className="muted">Â· {SUGG_MARKET_LABEL[s.country] ?? s.country}</span>{' '}
                      {s.eligible ? (
                        <span className="badge badge-green">Äá»§ Ä‘iá»u kiá»‡n</span>
                      ) : (
                        <span className="badge badge-red">ChÆ°a Ä‘áº¡t</span>
                      )}
                    </div>
                    {s.matched.length > 0 && (
                      <div className="muted" style={{ marginTop: 4, fontSize: 'var(--fs-xs)' }}>
                        âœ“ {s.matched.join(' Â· ')}
                      </div>
                    )}
                    {s.blockers.length > 0 && (
                      <div style={{ marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--danger, #c0392b)' }}>
                        âœ— {s.blockers.join(' Â· ')}
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
  PENDING: 'Chá» lÃ m',
  IN_PROGRESS: 'Äang lÃ m',
  DONE: 'HoÃ n táº¥t',
  BLOCKED: 'VÆ°á»›ng máº¯c',
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
      <h2 className="card-title">Há»“ sÆ¡ Visa &amp; ÄÆ°a Ä‘Ã³n</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Táº¡o checklist há»“ sÆ¡ visa tÃ¹y chá»‰nh theo quá»‘c gia (kÃ¨m háº¡n ná»™p tá»± tÃ­nh) vÃ  gá»£i Ã½ háº­u cáº§n
        (báº£o hiá»ƒm OSHC/IHS, vÃ© mÃ¡y bay, Ä‘Æ°a Ä‘Ã³n sÃ¢n bay, chá»— á»Ÿ).
      </div>

      <div className="toolbar">
        <div className="field">
          <label>Quá»‘c gia</label>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {VISA_COUNTRIES.map((c) => (
              <option key={c} value={c}>{SUGG_MARKET_LABEL[c] ?? c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>NgÃ y nháº­p há»c/xuáº¥t cáº£nh (dá»± kiáº¿n)</label>
          <input type="date" value={intakeDate} onChange={(e) => setIntakeDate(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          <Icon name="plus" size={16} /> {createMutation.isPending ? 'Äang táº¡oâ€¦' : 'Táº¡o há»“ sÆ¡'}
        </button>
      </div>
      {createMutation.error != null && <ErrorMessage error={createMutation.error} />}

      {casesQuery.isLoading ? (
        <Loading label="Äang táº£iâ€¦" />
      ) : casesQuery.error ? (
        <ErrorMessage error={casesQuery.error} />
      ) : casesQuery.data && casesQuery.data.items.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          {casesQuery.data.items.map((c) => (
            <VisaCaseCard key={c.id} visaCase={c} onChanged={() => queryClient.invalidateQueries({ queryKey: casesKey })} />
          ))}
        </div>
      ) : (
        <Empty label="ChÆ°a cÃ³ há»“ sÆ¡ visa nÃ o. Táº¡o má»™t há»“ sÆ¡ á»Ÿ trÃªn." />
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
            {done}/{tasks.length} má»¥c hoÃ n táº¥t
            {visaCase.targetIntakeDate ? ` Â· nháº­p há»c ${formatDate(visaCase.targetIntakeDate)}` : ''}
          </div>
        </div>
        <div className="row-actions">
          <button className="btn btn-sm" disabled={adviceMutation.isPending} onClick={() => adviceMutation.mutate()}>
            <Icon name="sparkles" size={14} /> {adviceMutation.isPending ? 'Äang tÆ° váº¥nâ€¦' : 'TÆ° váº¥n AI'}
          </button>
          <button className="btn btn-sm" disabled={logisticsMutation.isPending} onClick={() => logisticsMutation.mutate()}>
            {logisticsMutation.isPending ? 'Äang táº¡oâ€¦' : 'Gá»£i Ã½ háº­u cáº§n'}
          </button>
        </div>
      </div>

      {advice && (
        <pre className="code" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>{advice}</pre>
      )}

      {visaCase.logistics && (
        <div className="success-box" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          <strong>Háº­u cáº§n:</strong> Báº£o hiá»ƒm {visaCase.logistics.insuranceType || 'â€”'} Â· Chá»— á»Ÿ{' '}
          {visaCase.logistics.housingType || 'â€”'}
          {visaCase.logistics.notes ? `\n${visaCase.logistics.notes}` : ''}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Má»¥c</th>
                <th>Loáº¡i</th>
                <th>Háº¡n</th>
                <th>Tráº¡ng thÃ¡i</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'normal' }}>
                    {t.label} {t.required && <span className="badge badge-blue">Báº¯t buá»™c</span>}
                  </td>
                  <td>{t.category}</td>
                  <td>{t.dueAt ? formatDate(t.dueAt) : 'â€”'}</td>
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

// ---- Scholarship / financial matching (Du há»c) -----------------------------

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
      <h2 className="card-title">Há»c bá»•ng &amp; TÃ i chÃ­nh</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        Nháº­p ngÃ¢n sÃ¡ch/nÄƒm + GPA + IELTS Ä‘á»ƒ há»‡ thá»‘ng tÃ­nh chi phÃ­, Æ°á»›c tÃ­nh há»c bá»•ng vÃ  tÃ¬m chÆ°Æ¡ng
        trÃ¬nh trong kháº£ nÄƒng chi tráº£.
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>NgÃ¢n sÃ¡ch/nÄƒm (triá»‡u VND)</label>
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
        {mutation.isPending ? 'Äang tÃ­nhâ€¦' : 'Gá»£i Ã½ há»c bá»•ng & chi phÃ­'}
      </button>
      {mutation.error != null && <div style={{ marginTop: 12 }}><ErrorMessage error={mutation.error} /></div>}

      {results != null && (
        <div style={{ marginTop: 14 }}>
          {results.length === 0 ? (
            <Empty label="ChÆ°a cÃ³ chÆ°Æ¡ng trÃ¬nh du há»c nÃ o cÃ³ dá»¯ liá»‡u tÃ i chÃ­nh. HÃ£y bá»• sung há»c phÃ­/há»c bá»•ng cho Ä‘iá»ƒm Ä‘áº¿n." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>ChÆ°Æ¡ng trÃ¬nh</th>
                    <th>Tá»•ng CP/nÄƒm</th>
                    <th>Há»c bá»•ng Æ°á»›c tÃ­nh</th>
                    <th>CP rÃ²ng/nÄƒm</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.programId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        {r.notes.length > 0 && (
                          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{r.notes.join(' Â· ')}</div>
                        )}
                      </td>
                      <td>{r.totalCostPerYearVndM} tr</td>
                      <td>{r.estScholarshipPct}% (â‰ˆ{r.estScholarshipVndM} tr)</td>
                      <td>{r.netCostPerYearVndM} tr</td>
                      <td>
                        {r.affordable ? (
                          <span className="badge badge-green">Äá»§ ngÃ¢n sÃ¡ch</span>
                        ) : (
                          <span className="badge badge-red">Thiáº¿u {r.shortfallVndM} tr</span>
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
