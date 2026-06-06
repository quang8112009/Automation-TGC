/**
 * InterviewService — I/O + lifecycle for per-candidate visa-interview practice
 * sessions (Req 12.1–12.5). The pure modules decide WHAT: `InterviewAgent`
 * (Gemini-optional, grounded) produces questions/feedback and `scoreAnswer`
 * (pure rubric) scores answers. This service persists `InterviewSession` rows
 * and enforces SALES assigned-only scoping.
 *
 * RBAC snapshot (Req 12.3): unlike `visaService` (which scopes via the CURRENT
 * `candidate.assignedTo`), an interview session is scoped via the
 * `assignedAtCreation` snapshot taken when the session was created. SALES may
 * act on a session iff `assignedAtCreation === actor.userId`; ADMIN may act on
 * any session. Candidate-level operations (`create`, `list`) scope via the
 * current `candidate.assignedTo`, mirroring `visaService`.
 *
 * Mirrors `visaService`: 404 for a missing candidate/session, 403 for an
 * out-of-scope SALES actor, and never embeds secrets in any AI prompt (the
 * agent guards prompts before sending — Req 10.5, 10.6).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError, ValidationError } from '../infra/errors';
import { isRecord, asString } from '../platforms/narrow';
import { normalizeCountry } from '../visa/visaCatalog';
import { scoreAnswer, type AnswerCriterion, type InterviewScore } from './interviewScorer';
import { InterviewAgent, type InterviewSessionView } from './interviewAgent';
import type { InterviewQuestion } from './types';

/** Input for creating an interview session. */
export interface CreateInterviewInput {
  country?: string;
  visaType?: string;
}

/** A persisted interview session projected into a framework-free view. */
export interface InterviewSessionDetail {
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
  createdAt: Date;
  updatedAt: Date;
}

/** Number of words at which an answer is considered fully developed. */
const ANSWER_TARGET_WORDS = 20;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Coerce a stored `questions` Json column into `InterviewQuestion[]`. */
export function parseStoredQuestions(value: unknown): InterviewQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: InterviewQuestion[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const code = asString(item.code);
    const prompt = asString(item.prompt);
    const category = asString(item.category);
    if (code === undefined || prompt === undefined) continue;
    out.push({ code, prompt, category: category ?? 'GENERAL' });
  }
  return out;
}

/** Coerce a stored `answers`/`feedback` Json column into `Record<string,string>`. */
export function parseStoredStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const text = asString(raw);
    if (text !== undefined) out[key] = text;
  }
  return out;
}

/**
 * Build a deterministic rubric from a session's questions and the candidate's
 * answers. Each question contributes one criterion with `weight = 1` and a
 * per-answer score derived purely from answer completeness (word count toward
 * {@link ANSWER_TARGET_WORDS}); an unanswered question scores `0`. Deterministic
 * and framework-free so it can be property-tested alongside `scoreAnswer`.
 */
export function criteriaFromAnswers(
  questions: readonly InterviewQuestion[],
  answers: Record<string, string>,
): AnswerCriterion[] {
  return questions.map((q) => {
    const answer = answers[q.code];
    const words =
      typeof answer === 'string' && answer.trim().length > 0
        ? answer.trim().split(/\s+/u).length
        : 0;
    const score = Math.max(0, Math.min(1, words / ANSWER_TARGET_WORDS));
    return { key: q.code, weight: 1, score };
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class InterviewService {
  private readonly agent: InterviewAgent;

  constructor(
    private readonly prisma: PrismaClient,
    agent: InterviewAgent,
  ) {
    this.agent = agent;
  }

  /**
   * Create a practice session for a candidate + country/visa type. Scopes the
   * candidate (404 missing, 403 out-of-scope SALES — mirrors `visaService`),
   * SNAPSHOTS the current `candidate.assignedTo` into `assignedAtCreation` for
   * stable RBAC (Req 12.3), generates the question set via the agent, and
   * persists the session with the produced questions + `aiGenerated` flag.
   */
  async create(
    candidateId: string,
    input: CreateInterviewInput,
    actor: AuthInfo,
  ): Promise<InterviewSessionDetail> {
    const assignedTo = await this.assertCandidateAccess(candidateId, actor);

    const country = normalizeCountry(input.country);
    if (!country) {
      throw new ValidationError('country is required', 'INTERVIEW_COUNTRY_REQUIRED');
    }
    const visaType = (input.visaType ?? '').trim();

    const { questions, aiGenerated } = await this.agent.generateQuestions(country, visaType);

    const created = await this.prisma.interviewSession.create({
      data: {
        candidateId,
        country,
        visaType,
        questions: questions as unknown as Prisma.InputJsonValue,
        answers: {},
        feedback: {},
        // Snapshot the assignment at creation time for stable SALES RBAC (Req 12.3).
        assignedAtCreation: assignedTo ?? null,
        aiGenerated,
      },
    });
    return this.toDetail(created);
  }

  /**
   * Store the candidate's answers for a session and the agent's grounded
   * feedback (Req 12.1). Scopes via the session's `assignedAtCreation` snapshot
   * (NOT the current candidate assignment — Req 12.3).
   */
  async answer(
    sessionId: string,
    answers: Record<string, string>,
    actor: AuthInfo,
  ): Promise<InterviewSessionDetail> {
    const session = await this.requireSession(sessionId, actor);

    const cleanAnswers = parseStoredStringMap(answers);
    const view: InterviewSessionView = {
      id: session.id,
      candidateId: session.candidateId,
      country: session.country,
      visaType: session.visaType,
      questions: session.questions,
    };
    const { feedback, aiGenerated } = await this.agent.reviewAnswers(view, cleanAnswers);

    const updated = await this.prisma.interviewSession.update({
      where: { id: sessionId },
      data: {
        answers: cleanAnswers as unknown as Prisma.InputJsonValue,
        feedback: feedback as unknown as Prisma.InputJsonValue,
        aiGenerated: session.aiGenerated || aiGenerated,
      },
    });
    return this.toDetail(updated);
  }

  /**
   * Score a session's stored answers with the pure `scoreAnswer` rubric, persist
   * the score (Req 12.1), and return the `InterviewScore`. Scopes via the
   * session's `assignedAtCreation` snapshot (Req 12.3).
   */
  async score(sessionId: string, actor: AuthInfo): Promise<InterviewScore> {
    const session = await this.requireSession(sessionId, actor);

    const criteria = criteriaFromAnswers(session.questions, session.answers);
    const result = scoreAnswer(criteria);

    await this.prisma.interviewSession.update({
      where: { id: sessionId },
      data: { score: result.score },
    });
    return result;
  }

  /** List a candidate's interview sessions (scoped via current assignment). */
  async list(candidateId: string, actor: AuthInfo): Promise<InterviewSessionDetail[]> {
    await this.assertCandidateAccess(candidateId, actor);
    const rows = await this.prisma.interviewSession.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDetail(r));
  }

  // -------------------------------------------------------------------------
  // Scoping helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a candidate's `assignedTo` for SALES scoping. Returns the current
   * assignment (used to snapshot at creation time). 404 if the candidate is
   * missing, 403 if a SALES actor is not the assignee.
   */
  private async assertCandidateAccess(candidateId: string, actor: AuthInfo): Promise<string | null> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
      select: { assignedTo: true },
    });
    if (!candidate) {
      throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');
    }
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    return candidate.assignedTo;
  }

  /**
   * Load a session and enforce session-scoped access via the
   * `assignedAtCreation` snapshot (Req 12.3): SALES is allowed iff
   * `assignedAtCreation === actor.userId`; ADMIN may access any session. 404 if
   * the session is missing.
   */
  private async requireSession(
    sessionId: string,
    actor: AuthInfo,
  ): Promise<{
    id: string;
    candidateId: string;
    country: string;
    visaType: string;
    questions: InterviewQuestion[];
    answers: Record<string, string>;
    assignedAtCreation: string | null;
    aiGenerated: boolean;
  }> {
    const row = await this.prisma.interviewSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        candidateId: true,
        country: true,
        visaType: true,
        questions: true,
        answers: true,
        assignedAtCreation: true,
        aiGenerated: true,
      },
    });
    if (!row) {
      throw new NotFoundError('Interview session not found', 'INTERVIEW_SESSION_NOT_FOUND');
    }
    if (actor.role === 'SALES' && row.assignedAtCreation !== actor.userId) {
      throw new ForbiddenError();
    }
    return {
      id: row.id,
      candidateId: row.candidateId,
      country: row.country,
      visaType: row.visaType,
      questions: parseStoredQuestions(row.questions),
      answers: parseStoredStringMap(row.answers),
      assignedAtCreation: row.assignedAtCreation,
      aiGenerated: row.aiGenerated,
    };
  }

  /** Project a persisted session row into the framework-free detail view. */
  private toDetail(row: {
    id: string;
    candidateId: string;
    country: string;
    visaType: string;
    questions: Prisma.JsonValue;
    answers: Prisma.JsonValue;
    feedback: Prisma.JsonValue;
    score: number | null;
    assignedAtCreation: string | null;
    aiGenerated: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): InterviewSessionDetail {
    return {
      id: row.id,
      candidateId: row.candidateId,
      country: row.country,
      visaType: row.visaType,
      questions: parseStoredQuestions(row.questions),
      answers: parseStoredStringMap(row.answers),
      feedback: parseStoredStringMap(row.feedback),
      score: row.score,
      assignedAtCreation: row.assignedAtCreation,
      aiGenerated: row.aiGenerated,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
