/**
 * InterviewPrep (/interview-prep) — visa interview practice for a candidate.
 *
 * A consultant picks a candidate, starts a practice session for a country/visa
 * type, reviews the grounded question set (USA F-1 → I-20/SEVIS/DS-160, UK →
 * CAS/IHS, …), fills an answer per question to receive grounded feedback, and
 * scores the session.
 *
 * The interview endpoints are Gemini-OPTIONAL: when no AI key is configured (or
 * for a country without a visa-catalog template) the backend returns a
 * deterministic, knowledge-grounded question set / feedback flagged
 * `aiGenerated: false`. We surface that via <AiGroundingBadge/> as a valid
 * grounded result, never a failure.
 *
 * Endpoints (per candidate): POST/GET /interview-sessions,
 * POST /interview-sessions/:sessionId/answer,
 * POST /interview-sessions/:sessionId/score.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  answerInterviewSession,
  createInterviewSession,
  listInterviewSessions,
  scoreInterviewSession,
} from '../api/interviewPrep';
import type { InterviewScoreResult, InterviewSession } from '../api/interviewPrep';
import { listCandidates } from '../api/recruitment';
import { Empty, ErrorMessage, Loading, formatDate } from '../components/ui';
import { AiGroundingBadge } from '../components/AiGroundingBadge';
import { Icon } from '../components/Icon';

/** Countries with a curated question set in the backend visa catalog. */
const INTERVIEW_COUNTRIES: Array<{ value: string; label: string }> = [
  { value: 'USA', label: 'Hoa Kỳ (USA)' },
  { value: 'UK', label: 'Vương quốc Anh (UK)' },
  { value: 'AUSTRALIA', label: 'Úc (Australia)' },
  { value: 'CANADA', label: 'Canada' },
  { value: 'JAPAN', label: 'Nhật Bản (Japan)' },
  { value: 'OTHER', label: 'Quốc gia khác (bộ câu hỏi chung)' },
];

const CANDIDATE_PICK_LIMIT = 100;

export function InterviewPrep() {
  const queryClient = useQueryClient();

  const [candidateId, setCandidateId] = useState('');
  const [country, setCountry] = useState('USA');
  const [visaType, setVisaType] = useState('');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [score, setScore] = useState<InterviewScoreResult | null>(null);

  // Candidate picker fed by the existing candidates list (SALES is auto-scoped
  // server-side to its assigned candidates).
  const candidatesQuery = useQuery({
    queryKey: ['interviewPrep', 'candidates'],
    queryFn: () => listCandidates({ page: 1, limit: CANDIDATE_PICK_LIMIT }),
  });

  const sessionsQuery = useQuery({
    queryKey: ['interviewSessions', candidateId],
    queryFn: () => listInterviewSessions(candidateId),
    enabled: candidateId.trim().length > 0,
  });

  const activeSession: InterviewSession | null = useMemo(() => {
    const list = sessionsQuery.data ?? [];
    return list.find((s) => s.id === activeSessionId) ?? null;
  }, [sessionsQuery.data, activeSessionId]);

  // When the active session changes, seed the answer fields from any stored
  // answers and clear the previous score readout.
  useEffect(() => {
    setAnswers(activeSession ? { ...activeSession.answers } : {});
    setScore(null);
  }, [activeSessionId, activeSession]);

  const createMutation = useMutation({
    mutationFn: () =>
      createInterviewSession(candidateId.trim(), {
        country,
        visaType: visaType.trim() || undefined,
      }),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ['interviewSessions', candidateId] });
      setActiveSessionId(session.id);
    },
  });

  const answerMutation = useMutation({
    mutationFn: () => {
      if (!activeSession) throw new Error('Chưa chọn phiên luyện tập.');
      return answerInterviewSession(candidateId.trim(), activeSession.id, answers);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['interviewSessions', candidateId] });
    },
  });

  const scoreMutation = useMutation({
    mutationFn: () => {
      if (!activeSession) throw new Error('Chưa chọn phiên luyện tập.');
      return scoreInterviewSession(candidateId.trim(), activeSession.id);
    },
    onSuccess: (result) => {
      setScore(result);
      void queryClient.invalidateQueries({ queryKey: ['interviewSessions', candidateId] });
    },
  });

  function startSession() {
    if (candidateId.trim().length === 0) return;
    setScore(null);
    createMutation.mutate();
  }

  const sessions = sessionsQuery.data ?? [];

  return (
    <div className="reveal">
      <div className="page-header">
        <div>
          <div className="eyebrow">CRM tuyển dụng</div>
          <h1 className="page-title">Luyện phỏng vấn visa</h1>
        </div>
      </div>

      {/* Start a session */}
      <div className="card">
        <h2 className="card-title">Bắt đầu phiên luyện tập</h2>
        <div className="muted" style={{ marginBottom: 'var(--space-sm)' }}>
          Chọn ứng viên và quốc gia/loại visa. Bộ câu hỏi được tổng hợp từ tri thức quốc gia của hệ
          thống; khi AI được cấu hình, câu hỏi và phản hồi sẽ do mô hình diễn đạt lại.
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label>Ứng viên *</label>
            {candidatesQuery.isLoading ? (
              <Loading label="Đang tải ứng viên…" inline />
            ) : candidatesQuery.error ? (
              <ErrorMessage error={candidatesQuery.error} />
            ) : (
              <select value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
                <option value="">— Chọn ứng viên —</option>
                {(candidatesQuery.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                    {c.phone ? ` · ${c.phone}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="field">
            <label>Quốc gia *</label>
            <select value={country} onChange={(e) => setCountry(e.target.value)}>
              {INTERVIEW_COUNTRIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Loại visa (tùy chọn)</label>
            <input
              value={visaType}
              onChange={(e) => setVisaType(e.target.value)}
              placeholder="VD: F-1, J-1, M-1…"
            />
          </div>
        </div>
        <button
          className="btn btn-primary"
          disabled={createMutation.isPending || candidateId.trim().length === 0}
          onClick={startSession}
        >
          <Icon name="bot" size={16} />
          {createMutation.isPending ? 'Đang tạo phiên…' : 'Bắt đầu phiên'}
        </button>
        {createMutation.error != null && (
          <div style={{ marginTop: 'var(--space-sm)' }}>
            <ErrorMessage error={createMutation.error} />
          </div>
        )}
      </div>

      {/* Sessions list */}
      {candidateId.trim().length > 0 && (
        <div className="card">
          <h2 className="card-title">Phiên luyện tập</h2>
          {sessionsQuery.isLoading ? (
            <Loading variant="table" rows={4} />
          ) : sessionsQuery.error ? (
            <ErrorMessage error={sessionsQuery.error} />
          ) : sessions.length === 0 ? (
            <Empty
              label="Chưa có phiên luyện tập nào cho ứng viên này."
              icon="bot"
              action={
                <button
                  className="btn btn-primary btn-sm"
                  disabled={createMutation.isPending}
                  onClick={startSession}
                >
                  <Icon name="bot" size={16} />
                  Bắt đầu phiên đầu tiên
                </button>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Quốc gia</th>
                    <th>Loại visa</th>
                    <th>Số câu hỏi</th>
                    <th>Điểm</th>
                    <th>Nguồn</th>
                    <th>Ngày tạo</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr
                      key={s.id}
                      className={s.id === activeSessionId ? 'is-selected' : undefined}
                    >
                      <td>{s.country}</td>
                      <td>{s.visaType || '—'}</td>
                      <td>{s.questions.length}</td>
                      <td>{s.score == null ? '—' : `${Math.round(s.score * 100)}%`}</td>
                      <td>
                        <AiGroundingBadge aiGenerated={s.aiGenerated} />
                      </td>
                      <td>{formatDate(s.createdAt)}</td>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => setActiveSessionId(s.id)}
                        >
                          Mở
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Active session: questions + answers + feedback + score */}
      {activeSession && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
            <h2 className="card-title" style={{ margin: 0 }}>
              Phiên {activeSession.country}
              {activeSession.visaType ? ` · ${activeSession.visaType}` : ''}
            </h2>
            <AiGroundingBadge aiGenerated={activeSession.aiGenerated} />
          </div>

          {activeSession.questions.length === 0 ? (
            <Empty label="Phiên này chưa có câu hỏi." icon="bot" />
          ) : (
            <div className="steps-list">
              {activeSession.questions.map((q, idx) => {
                const feedback = activeSession.feedback[q.code];
                return (
                  <div key={q.code} className="step-row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div>
                        <span className="badge badge-gray">{q.category}</span>{' '}
                        <strong>
                          Câu {idx + 1}. {q.prompt}
                        </strong>
                      </div>
                      <div className="field" style={{ marginTop: 'var(--space-sm)' }}>
                        <label>Câu trả lời</label>
                        <textarea
                          value={answers[q.code] ?? ''}
                          onChange={(e) =>
                            setAnswers((a) => ({ ...a, [q.code]: e.target.value }))
                          }
                          placeholder="Nhập câu trả lời luyện tập của ứng viên…"
                        />
                      </div>
                      {feedback ? (
                        <div className="notice" style={{ marginTop: 'var(--space-xs)' }}>
                          <span
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-sm)' }}
                          >
                            <Icon name="lightbulb" size={16} />
                            <span>{feedback}</span>
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="row-actions" style={{ marginTop: 'var(--space-md)' }}>
            <button
              className="btn btn--secondary"
              disabled={answerMutation.isPending || activeSession.questions.length === 0}
              onClick={() => answerMutation.mutate()}
            >
              <Icon name="send" size={16} />
              {answerMutation.isPending ? 'Đang gửi…' : 'Gửi câu trả lời'}
            </button>
            <button
              className="btn btn-primary"
              disabled={scoreMutation.isPending || activeSession.questions.length === 0}
              onClick={() => scoreMutation.mutate()}
            >
              <Icon name="check" size={16} />
              {scoreMutation.isPending ? 'Đang chấm…' : 'Chấm điểm phiên'}
            </button>
          </div>

          {answerMutation.error != null && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <ErrorMessage error={answerMutation.error} />
            </div>
          )}
          {scoreMutation.error != null && (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <ErrorMessage error={scoreMutation.error} />
            </div>
          )}

          {score != null && (
            <div className="notice" style={{ marginTop: 'var(--space-md)' }}>
              {score.insufficientData ? (
                <>
                  <strong>Chưa đủ dữ liệu để chấm điểm.</strong> Hãy bổ sung câu trả lời cho các
                  câu hỏi rồi chấm lại.
                </>
              ) : (
                <>
                  <strong>Điểm luyện tập: {Math.round(score.score * 100)}%</strong>
                  <div className="muted" style={{ marginTop: 'var(--space-xs)' }}>
                    Điểm phản ánh mức độ đầy đủ của câu trả lời theo rubric. Tiếp tục luyện tập để
                    cải thiện.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
