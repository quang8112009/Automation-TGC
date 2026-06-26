/**
 * Privacy & consent route registration (security/privacy hardening).
 *
 * Thin Fastify layer wiring ConsentService + ErasureService behind requireAuth.
 * Consent reads/writes and erasure are administrative privacy operations, so
 * they mount behind `settings` (ADMIN-only under the pure RBAC policy; SALES is
 * denied 403). Services throw typed AppError subclasses mapped by the global
 * error handler. Uses the `/api/v1` gateway prefix.
 *
 * Endpoints:
 *   POST /api/v1/privacy/consent                      record a consent event
 *   GET  /api/v1/privacy/consent/:subjectType/:id     consent history for subject
 *   POST /api/v1/privacy/erasure                      execute right-to-erasure
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { getAuth, rbacGuard, requireAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import { ValidationError } from '../infra/errors';
import { ConsentService } from './consentService';
import { ErasureService } from './erasureService';

export interface PrivacyRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function registerPrivacyRoutes(app: FastifyInstance, deps: PrivacyRouteDeps): void {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const consent = new ConsentService(prisma);
  const erasure = new ErasureService(prisma);

  // settings is ADMIN-only under the pure RBAC policy (SALES -> 403). Static
  // targets — no per-resource owner resolution needed.
  const readGuard = rbacGuard(() => ({ module: 'settings', action: 'read' }), auditor);
  const writeGuard = rbacGuard(() => ({ module: 'settings', action: 'update' }), auditor);

  // Record a consent event (GRANTED/WITHDRAWN). Append-only.
  app.post(
    '/api/v1/privacy/consent',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actor = getAuth(request).userId;
      const record = await consent.record({
        subjectType: asString(body.subjectType) ?? '',
        subjectId: asString(body.subjectId) ?? '',
        scope: asString(body.scope) ?? '',
        action: asString(body.action),
        source: asString(body.source),
        note: asString(body.note) ?? null,
        actor,
      });
      return reply.code(201).send(record);
    },
  );

  // Consent history for a subject.
  app.get(
    '/api/v1/privacy/consent/:subjectType/:subjectId',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const { subjectType, subjectId } = request.params as {
        subjectType: string;
        subjectId: string;
      };
      const items = await consent.history(subjectType, subjectId);
      return reply.code(200).send({ items });
    },
  );

  // Execute right-to-erasure for a subject. Returns a counts-only summary.
  app.post(
    '/api/v1/privacy/erasure',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const subjectType = asString(body.subjectType);
      const subjectId = asString(body.subjectId);
      if (!subjectType || !subjectId) {
        throw new ValidationError(
          'subjectType and subjectId are required',
          'ERASURE_INPUT_REQUIRED',
        );
      }
      const result = await erasure.erase({
        subjectType,
        subjectId,
        requestedBy: getAuth(request).userId,
        reason: asString(body.reason),
      });
      return reply.code(200).send(result);
    },
  );
}
