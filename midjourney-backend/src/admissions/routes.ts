/**
 * Admissions routes — academic profile (read/upsert) + admission scoring across
 * the active program catalogue (study-abroad-ai-advisor-suite — Nhóm 1,
 * Req 1.6, 5.2, 5.3, 5.4, 21.6, 21.7).
 *
 * All routes mount behind the Foundation authentication + RBAC middleware under
 * the existing module 'lead_management' so the established SALES (assigned-only)
 * and ADMIN policies apply without changing the RBAC policy table. For the
 * candidate :id routes the RBAC target resolves ownerUserId from the
 * candidate's assignedTo (mirrors candidateTargetById in recruitment/routes.ts
 * and the guard wiring in visa/routes.ts) so the SALES assigned-only policy is
 * enforced before the service is reached; the service re-checks scope as well.
 *
 * The route layer stays thin: it only shapes/narrows untrusted request input
 * into AcademicInput via small asNumber/asString helpers, wires auth/RBAC, and
 * delegates the decisions (range validation → 400, scoring, banding) to
 * AdmissionService. Only the allowed status-code set is used (200 here; the
 * service throws typed AppErrors that the global handler maps to 400/401/403/404).
 *
 * Additive registrar; app.ts wiring is handled separately (task 9.1).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import { AdmissionService } from './admissionService';
import { governanceRoute } from '../governance/middleware';
import type { AcademicInput } from './admissionService';

export interface AdmissionsRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

interface IdParams {
  id: string;
}

/** Narrow untrusted input to a finite number, or undefined (treated as unknown). */
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Narrow untrusted input to a non-empty string, or undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export async function registerAdmissionsRoutes(
  app: FastifyInstance,
  deps: AdmissionsRouteDeps,
): Promise<void> {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const service = new AdmissionService(prisma);

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
    }, auditor);

  // ---- Academic profile (1–1 with the candidate) ----------------------------
  app.put(
    '/api/v1/candidates/:id/academic-profile',
    { ...governanceRoute({ audit: true }), preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      // Shape untrusted input into AcademicInput; the service validates the
      // GPA/IELTS boundaries (out-of-range → 400).
      const input: AcademicInput = {
        gpa: asNumber(body.gpa),
        gpaScale: asNumber(body.gpaScale),
        ielts: asNumber(body.ielts),
        toefl: asNumber(body.toefl),
        jlpt: asString(body.jlpt),
        educationLevel: asString(body.educationLevel),
      };
      const profile = await service.upsertAcademic(id, input, actor);
      return reply.code(200).send(profile);
    },
  );

  app.get(
    '/api/v1/candidates/:id/academic-profile',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const profile = await service.getAcademic(id, actor);
      return reply.code(200).send(profile);
    },
  );

  // ---- Admission scoring (Reach/Match/Safety across active programs) ---------
  app.post(
    '/api/v1/candidates/:id/admissions/score',
    { ...governanceRoute({ audit: true }), preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const results = await service.scoreCandidate(id, actor);
      return reply.code(200).send(results);
    },
  );
}
