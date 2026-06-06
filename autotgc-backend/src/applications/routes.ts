/**
 * Program application routes — per-candidate `ApplicationCase`s and the merged
 * application/visa timeline (study-abroad-ai-advisor-suite, Requirements 13 & 14).
 *
 * Mirrors `recruitment/routes.ts` and `visa/routes.ts`: all routes mount behind
 * the Foundation `requireAuth` + `rbacGuard` middleware under the existing
 * module 'lead_management', so the established SALES (assigned-only) and ADMIN
 * policies apply without changing the RBAC policy table. For candidate `:id`
 * routes the RBAC target resolves `ownerUserId` from the candidate's
 * `assignedTo` (mirrors `candidateTargetById`) so the SALES assigned-only policy
 * is enforced by `authorize()`. Uses the /api/v1 gateway prefix.
 *
 * The route layer stays thin: it shapes requests/responses, wires auth/RBAC, and
 * delegates to `ApplicationService`. The service owns validation (e.g. a missing
 * `intakeLabel` throws `ValidationError` → 400) and SALES candidate scoping.
 *
 * Additive registrar; app.ts wiring is handled separately (task 9.1).
 *
 * _Requirements: 13.1, 14.1, 22.1, 22.2, 22.4_
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { Action } from '../auth/rbac';
import type { OversightService } from '../oversight/oversightService';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import { ApplicationService } from './applicationService';
import type { CreateApplicationInput } from './applicationService';

export interface ApplicationRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Central oversight emit point; threaded into the service when present. */
  oversight?: OversightService;
}

interface IdParams {
  id: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export async function registerApplicationRoutes(
  app: FastifyInstance,
  deps: ApplicationRouteDeps,
): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const service = new ApplicationService(prisma, deps.oversight);

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

  // ---- Program application cases --------------------------------------------
  app.post(
    '/api/v1/candidates/:id/applications',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: CreateApplicationInput = {
        programId: asString(body.programId),
        intakeLabel: asString(body.intakeLabel) ?? '',
        targetIntakeDate: asString(body.targetIntakeDate),
        country: asString(body.country),
      };
      const created = await service.createCase(id, input, actor);
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/api/v1/candidates/:id/applications',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await service.listForCandidate(id, actor);
      return reply.code(200).send(result);
    },
  );

  // Merged application/visa timeline for the candidate. A distinct static path
  // under :id ('applications/timeline'), so it does not conflict with the
  // collection route above.
  app.get(
    '/api/v1/candidates/:id/applications/timeline',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await service.timeline(id, actor);
      return reply.code(200).send(result);
    },
  );
}
