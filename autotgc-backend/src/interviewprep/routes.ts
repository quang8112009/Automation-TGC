/**
 * Interview-prep routes — per-candidate visa-interview practice sessions
 * (Requirements 12.3, 12.4, 12.5).
 *
 * All routes mount behind requireAuth + rbacGuard under the existing
 * 'lead_management' module so the established SALES (assigned-only) and ADMIN
 * policies apply without changing the RBAC policy table. The route layer stays
 * thin: it shapes requests/responses and wires auth/RBAC, delegating all logic
 * to `InterviewService` (which in turn uses the Gemini-optional `InterviewAgent`
 * and the pure `scoreAnswer` rubric).
 *
 * RBAC scoping has TWO shapes here:
 *   - Collection routes (create/list) resolve ownerUserId from the candidate's
 *     CURRENT `assignedTo` (mirrors `candidateTargetById` in recruitment/visa
 *     routes). For create this is correct: the session snapshots the current
 *     assignment at creation time.
 *   - Per-session routes (answer/score) resolve ownerUserId from the SESSION's
 *     `assignedAtCreation` snapshot (Req 12.3) — NOT the candidate's current
 *     assignment — so SALES access follows the assignment captured when the
 *     session was created.
 *
 * Additive registrar; app.ts wiring is handled separately (task 9.1). Uses the
 * /api/v1 gateway prefix and only the allowed HTTP status codes (201/200; the
 * services throw typed AppErrors mapped to 400/403/404 by the global handler).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import type { ContentGenerator } from '../strategy/personaService';
import { KnowledgeService } from '../recruitment/knowledge/knowledgeService';
import { InterviewAgent } from './interviewAgent';
import { InterviewService } from './interviewService';
import type { CreateInterviewInput } from './interviewService';

export interface InterviewPrepRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; the interview agent grounds + phrases output when present. */
  gemini?: ContentGenerator;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

interface IdParams {
  id: string;
}

interface SessionParams {
  id: string;
  sessionId: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Coerce an untrusted body value into a `Record<string, string>` (drops non-strings). */
function asStringRecord(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function registerInterviewPrepRoutes(
  app: FastifyInstance,
  deps: InterviewPrepRouteDeps,
): Promise<void> {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const knowledge = new KnowledgeService(prisma);
  const agent = new InterviewAgent(knowledge, deps.gemini);
  const service = new InterviewService(prisma, agent);

  // For candidate :id routes, resolve ownerUserId from the candidate's CURRENT
  // assignedTo so the SALES assigned-only policy can be enforced by authorize()
  // (mirrors candidateTargetById in recruitment/routes.ts).
  const candidateTargetById = (action: Action) =>
    rbacGuard(async (request: FastifyRequest) => {
      const { id } = request.params as IdParams;
      const candidate = await prisma.candidateProfile.findUnique({
        where: { id },
        select: { assignedTo: true },
      });
      return {
        module: 'lead_management' as const,
        action,
        ownerUserId: candidate?.assignedTo ?? undefined,
      };
    }, auditor);

  // For per-session routes, resolve ownerUserId from the session's
  // assignedAtCreation snapshot (Req 12.3) rather than the candidate's current
  // assignment, so SALES access tracks the assignment captured at creation time.
  const sessionTargetById = (action: Action) =>
    rbacGuard(async (request: FastifyRequest) => {
      const { sessionId } = request.params as SessionParams;
      const session = await prisma.interviewSession.findUnique({
        where: { id: sessionId },
        select: { assignedAtCreation: true },
      });
      return {
        module: 'lead_management' as const,
        action,
        ownerUserId: session?.assignedAtCreation ?? undefined,
      };
    }, auditor);

  // ---- Interview sessions (per candidate) -----------------------------------
  app.post(
    '/api/v1/candidates/:id/interview-sessions',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: CreateInterviewInput = {
        country: asString(body.country),
        visaType: asString(body.visaType),
      };
      const session = await service.create(id, input, actor);
      return reply.code(201).send(session);
    },
  );

  app.get(
    '/api/v1/candidates/:id/interview-sessions',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const sessions = await service.list(id, actor);
      return reply.code(200).send(sessions);
    },
  );

  app.post(
    '/api/v1/candidates/:id/interview-sessions/:sessionId/answer',
    { preHandler: [auth, sessionTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { sessionId } = request.params as SessionParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const answers = asStringRecord(body.answers);
      const session = await service.answer(sessionId, answers, actor);
      return reply.code(200).send(session);
    },
  );

  app.post(
    '/api/v1/candidates/:id/interview-sessions/:sessionId/score',
    { preHandler: [auth, sessionTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { sessionId } = request.params as SessionParams;
      const result = await service.score(sessionId, actor);
      return reply.code(200).send(result);
    },
  );
}
