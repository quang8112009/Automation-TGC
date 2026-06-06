/**
 * Roadmap routes — per-candidate study→career→PR ROI estimates, profile
 * readiness scoring, and REVIEW MODE roadmap narratives
 * (study-abroad-ai-advisor-suite — Nhóm 5, Req 17.3, 18.1, 22.1, 22.2, 22.4).
 *
 * All routes mount behind the Foundation authentication + RBAC middleware under
 * the existing module 'lead_management' so the established SALES (assigned-only)
 * and ADMIN policies apply without changing the RBAC policy table. For the
 * candidate :id routes the RBAC target resolves `ownerUserId` from the owning
 * `CandidateProfile.assignedTo` (mirrors `candidateTargetById` in
 * recruitment/routes.ts and essays/routes.ts) so the SALES assigned-only policy
 * is enforced. Uses the /api/v1 gateway prefix.
 *
 * Thin route layer: it only shapes requests/responses, wires auth/RBAC, and
 * delegates to {@link RoadmapService}. Illegal narrative status transitions are
 * surfaced by the service as 409 (the SAME guarded state machine as essays —
 * Req 17.3). This file does NOT modify existing files; it exports a registrar
 * that the application wires in additively (task 9.1).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import { ValidationError } from '../infra/errors';
import type { ContentGenerator } from '../strategy/personaService';
import { KnowledgeService } from '../recruitment/knowledge/knowledgeService';
import { RoadmapService } from './roadmapService';
import { ESSAY_TRANSITIONS } from '../essays/essayStateMachine';
import type { EssayStatus } from '../essays/essayStateMachine';
import type { EssayGenMode } from '../essays/essayWriter';

export interface RoadmapRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; the roadmap narrator grounds + phrases drafts when present. */
  gemini?: ContentGenerator;
}

interface IdParams {
  id: string;
}

interface NarrativeIdParams {
  id: string;
  nid: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The distinct status values reachable through the (shared) essay state machine. */
const ESSAY_STATUSES: ReadonlySet<EssayStatus> = new Set<EssayStatus>(
  ESSAY_TRANSITIONS.flatMap(([from, to]) => [from, to]),
);

/** Type guard: is `v` a valid `EssayStatus` transition target? */
function isEssayStatus(v: unknown): v is EssayStatus {
  return typeof v === 'string' && ESSAY_STATUSES.has(v as EssayStatus);
}

/** Narrow the optional narrative generation mode; defaults to 'AI' (Req 6.7-style). */
function asGenMode(v: unknown): EssayGenMode {
  return v === 'STRUCTURED' ? 'STRUCTURED' : 'AI';
}

export async function registerRoadmapRoutes(
  app: FastifyInstance,
  deps: RoadmapRouteDeps,
): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const knowledge = new KnowledgeService(prisma);
  const service = new RoadmapService(prisma, knowledge, deps.gemini);

  // For candidate :id routes, resolve ownerUserId from the candidate's
  // assignedTo so the SALES assigned-only policy can be enforced by authorize().
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
    });

  // ---- Roadmap ROI estimate (Req 16.1) ---------------------------------------
  app.post(
    '/api/v1/candidates/:id/roadmap',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const programId = asString(body.programId);
      if (!programId) {
        throw new ValidationError('programId is required', 'PROGRAM_ID_REQUIRED');
      }
      const estimate = await service.estimate(id, programId, actor);
      return reply.code(200).send(estimate);
    },
  );

  // ---- Profile readiness scoring (Req 18.1, 18.5) ----------------------------
  app.get(
    '/api/v1/candidates/:id/roadmap/readiness',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await service.readiness(id, actor, asString(q.programId));
      return reply.code(200).send(result);
    },
  );

  // ---- Roadmap narrative (REVIEW MODE — Req 17.1, 17.2, 17.3) -----------------
  app.post(
    '/api/v1/candidates/:id/roadmap/narrative',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const programId = asString(body.programId);
      if (!programId) {
        throw new ValidationError('programId is required', 'PROGRAM_ID_REQUIRED');
      }
      const created = await service.createNarrative(id, programId, asGenMode(body.mode), actor);
      return reply.code(201).send(created);
    },
  );

  app.post(
    '/api/v1/candidates/:id/roadmap/narrative/:nid/transition',
    { preHandler: [auth, candidateTargetById('status_update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { nid } = request.params as NarrativeIdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = asString(body.target);
      if (!isEssayStatus(target)) {
        throw new ValidationError('Invalid roadmap narrative status target', 'ROADMAP_STATUS_INVALID');
      }
      const updated = await service.transitionNarrative(nid, target, actor);
      return reply.code(200).send(updated);
    },
  );
}
