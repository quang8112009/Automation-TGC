/**
 * Typed wrappers for the visa interview-prep practice endpoints
 * (study-abroad-ai-advisor-suite, Requirements 10.1, 11.1, 12.1). Built on the
 * shared `api` helper; all paths use the /api/v1 gateway prefix and inherit
 * Bearer auth + the { error: { code, message } } envelope handling.
 *
 * These endpoints never surface a 502 "AI not configured": the backend
 * `InterviewAgent` is Gemini-optional and returns a deterministic, knowledge-
 * grounded question set / feedback flagged `aiGenerated: false` when no Gemini
 * key is configured (or for countries without a visa-catalog template). Callers
 * should render those as valid grounded results, not failures.
 *
 * NOTE: kept separate from `studyAdvisor.ts` on purpose so the per-candidate
 * admissions/essay/timeline/roadmap panels and this interview-prep page do not
 * collide on a single shared module.
 */
import { api } from '../lib/apiClient';

/** A single visa-interview practice question (mirrors backend InterviewQuestion). */
export interface InterviewQuestion {
  code: string;
  prompt: string;
  category: string;
}

/**
 * A persisted interview session (mirrors backend InterviewSessionDetail). Dates
 * are ISO strings over the wire. `score` is null until the session is scored.
 */
export interface InterviewSession {
  id: string;
  candidateId: string;
  country: string;
  visaType: string;
  questions: InterviewQuestion[];
  answers: Record<string, string>;
  feedback: Record<string, string>;
  score: number | null;
  assignedAtCreation: string | null;
  aiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Result of scoring a session (mirrors backend InterviewScore). */
export interface InterviewScoreResult {
  /** Aggregate practice score, always finite and in [0, 1]. */
  score: number;
  /** `true` when the rubric had no effective weight (no division performed). */
  insufficientData: boolean;
}

/** Input for starting a new practice session. */
export interface CreateInterviewSessionInput {
  /** Country code grounding the question set (e.g. USA, UK, JAPAN). */
  country: string;
  /** Optional visa type to layer deterministic refinements (e.g. F-1, J-1). */
  visaType?: string;
}

function base(candidateId: string): string {
  return `/api/v1/candidates/${encodeURIComponent(candidateId)}/interview-sessions`;
}

/** POST /interview-sessions — start a session for a country/visa type. */
export function createInterviewSession(
  candidateId: string,
  input: CreateInterviewSessionInput,
): Promise<InterviewSession> {
  return api.post<InterviewSession>(base(candidateId), {
    country: input.country,
    visaType: input.visaType,
  });
}

/** GET /interview-sessions — list a candidate's practice sessions (newest first). */
export function listInterviewSessions(candidateId: string): Promise<InterviewSession[]> {
  return api.get<InterviewSession[]>(base(candidateId));
}

/** POST /interview-sessions/:sessionId/answer — submit answers, get grounded feedback. */
export function answerInterviewSession(
  candidateId: string,
  sessionId: string,
  answers: Record<string, string>,
): Promise<InterviewSession> {
  return api.post<InterviewSession>(
    `${base(candidateId)}/${encodeURIComponent(sessionId)}/answer`,
    { answers },
  );
}

/** POST /interview-sessions/:sessionId/score — compute the practice score. */
export function scoreInterviewSession(
  candidateId: string,
  sessionId: string,
): Promise<InterviewScoreResult> {
  return api.post<InterviewScoreResult>(
    `${base(candidateId)}/${encodeURIComponent(sessionId)}/score`,
  );
}
