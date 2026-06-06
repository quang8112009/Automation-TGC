/**
 * Essay routes — per-candidate SOP / motivation / CV drafts with the
 * REVIEW MODE lifecycle (study-abroad-ai-advisor-suite — Nhóm 2, Req 9.2–9.5, 22.5).
 *
 * All routes mount behind the Foundation authentication + RBAC middleware under
 * the existing module 'lead_management' so the established SALES (assigned-only)
 * and ADMIN policies apply without changing the RBAC policy table. For the
 * candidate :id routes the RBAC target resolves `ownerUserId` from the owning
 * `CandidateProfile.assignedTo` (mirrors `candidateTargetById` in
 * recruitment/routes.ts) so the SALES assigned-only policy is enforced.
 *
 * Every essay route maps to the `update`/`read`/`status_update` actions — the
 * DELETE deliberately uses `update` (NOT `delete`) so SALES retains full CRUD on
 * its assigned candidates' drafts (Req 22.5). Uses the /api/v1 gateway prefix.
 *
 * Thin route layer: it only shapes requests/responses, wires auth/RBAC, and
 * delegates to {@link EssayService}. This file does NOT modify existing files;
 * it exports a registrar that the application wires in additively (task 9.1).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import { ValidationError } from '../infra/errors';
import type { ContentGenerator } from '../strategy/personaService';
import { EssayService } from './essayService';
import type { CreateEssayInput } from './essayService';
import { ESSAY_TRANSITIONS } from './essayStateMachine';
import type { EssayStatus } from './essayStateMachine';

export interface EssayRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; the essay writer grounds + phrases drafts when present. */
  gemini?: ContentGenerator;
}

interface IdParams {
  id: string;
}

interface EssayIdParams {
  id: string;
  essayId: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The distinct status values reachable through the essay state machine. */
const ESSAY_STATUSES: ReadonlySet<EssayStatus> = new Set<EssayStatus>(
  ESSAY_TRANSITIONS.flatMap(([from, to]) => [from, to]),
);

/** Type guard: is `v` a valid `EssayStatus` transition target? */
function isEssayStatus(v: unknown): v is EssayStatus {
  return typeof v === 'string' && ESSAY_STATUSES.has(v as EssayStatus);
}

export async function registerEssayRoutes(
  app: FastifyInstance,
  deps: EssayRouteDeps,
): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const essays = new EssayService(prisma, deps.gemini);

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

  // ---- Essay drafts ----------------------------------------------------------
  app.post(
    '/api/v1/candidates/:id/essays',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const created = await essays.create(id, (request.body ?? {}) as CreateEssayInput, actor);
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/api/v1/candidates/:id/essays',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await essays.list(id, actor);
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/api/v1/candidates/:id/essays/:essayId/review',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { essayId } = request.params as EssayIdParams;
      const review = await essays.review(essayId, actor);
      return reply.code(200).send(review);
    },
  );

  app.post(
    '/api/v1/candidates/:id/essays/:essayId/transition',
    { preHandler: [auth, candidateTargetById('status_update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { essayId } = request.params as EssayIdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = asString(body.target);
      if (!isEssayStatus(target)) {
        throw new ValidationError('Invalid essay status target', 'ESSAY_STATUS_INVALID');
      }
      const updated = await essays.transition(essayId, target, actor);
      return reply.code(200).send(updated);
    },
  );

  // DELETE maps to the `update` action (NOT `delete`) so SALES retains full CRUD
  // on its assigned candidates' drafts (Req 22.5).
  app.delete(
    '/api/v1/candidates/:id/essays/:essayId',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { essayId } = request.params as EssayIdParams;
      await essays.remove(essayId, actor);
      return reply.code(200).send({ status: 'ok' });
    },
  );
}
