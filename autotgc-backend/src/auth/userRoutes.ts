/**
 * Staff account-management route registration (ADMIN-only) — Req 4.2, 4.3, 5.1,
 * 5.9, 12.5.
 *
 * Thin Fastify layer: shapes requests/responses, wires auth + RBAC, and
 * delegates to `UserManagementService`. It mirrors the registration style of
 * `recruitment/documents/routes.ts` and `recruitment/agent/routes.ts`:
 *
 *   - Every route mounts behind `requireAuth` + `rbacGuard(() => ({ module:
 *     'user_management', action }))`. Under the pure RBAC policy in
 *     `auth/rbac.ts`, ADMIN is allowed on every action while SALES is denied
 *     `user_management` outright (403) — so no per-route owner resolution is
 *     needed (Req 5.9).
 *   - The service throws typed `AppError` subclasses (ValidationError 400,
 *     ConflictError 409, NotFoundError 404) which the global error handler maps
 *     onto the allowed status set; routes only emit allowed success codes.
 *
 * Uses the `/api/v1` gateway prefix. This file is additive; `app.ts` wiring is
 * task 8.1.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService, Role } from './jwt';
import { requireAuth, rbacGuard } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import { ValidationError } from '../infra/errors';
import { UserManagementService } from './userManagementService';

export interface UserManagementRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

interface IdParams {
  id: string;
}

/** Narrow an unknown value to a non-empty string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function registerUserManagementRoutes(
  app: FastifyInstance,
  deps: UserManagementRouteDeps,
): void {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const service = new UserManagementService(prisma);

  // user_management is ADMIN-only under the pure RBAC policy: ADMIN passes every
  // action, SALES is denied the module (403). Static targets — no owner resolve.
  const readGuard = rbacGuard(() => ({ module: 'user_management', action: 'read' }), auditor);
  const createGuard = rbacGuard(() => ({ module: 'user_management', action: 'create' }), auditor);
  const updateGuard = rbacGuard(() => ({ module: 'user_management', action: 'update' }), auditor);

  // GET /api/v1/users — list every account (username/email/role/locked). (Req 5.1)
  app.get(
    '/api/v1/users',
    { preHandler: [auth, readGuard] },
    async (_request, reply) => {
      const users = await service.list();
      return reply.code(200).send({ users });
    },
  );

  // POST /api/v1/users — create a SALES account. The service surfaces 400 for
  // missing/blank fields and 409 for a duplicate username. (Req 5.2–5.4)
  app.post(
    '/api/v1/users',
    { preHandler: [auth, createGuard] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const user = await service.createSalesUser({
        username: asString(body.username),
        email: asString(body.email),
        password: asString(body.password),
      });
      return reply.code(201).send(user);
    },
  );

  // POST /api/v1/users/:id/lock — lock an account. 404 if not found. (Req 5.5)
  app.post(
    '/api/v1/users/:id/lock',
    { preHandler: [auth, updateGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = await service.lock(id);
      return reply.code(200).send(user);
    },
  );

  // POST /api/v1/users/:id/unlock — unlock + reset failedLoginCount. 404 if not
  // found. (Req 5.6)
  app.post(
    '/api/v1/users/:id/unlock',
    { preHandler: [auth, updateGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = await service.unlock(id);
      return reply.code(200).send(user);
    },
  );

  // POST /api/v1/users/:id/role — change role. `role` must be present (400); the
  // service rejects values outside {ADMIN, SALES} (400) and missing users (404).
  // (Req 5.7)
  app.post(
    '/api/v1/users/:id/role',
    { preHandler: [auth, updateGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const role = asString(body.role);
      if (!role) {
        throw new ValidationError('role is required', 'ROLE_REQUIRED');
      }
      const user = await service.changeRole(id, role as Role);
      return reply.code(200).send(user);
    },
  );

  // POST /api/v1/users/:id/reset-password — reset password. `password` must be
  // present (400); the service hashes it via argon2 and never stores plaintext,
  // and returns 404 for a missing user. (Req 5.8)
  app.post(
    '/api/v1/users/:id/reset-password',
    { preHandler: [auth, updateGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const password = asString(body.password);
      if (!password) {
        throw new ValidationError('password is required', 'PASSWORD_REQUIRED');
      }
      await service.resetPassword(id, password);
      return reply.code(200).send({ status: 'ok' });
    },
  );
}
