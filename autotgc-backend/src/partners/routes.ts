/**
 * Partners & Destinations route registration (đối tác đã hợp tác + nơi có thể
 * đưa đi XKLĐ với điều kiện cụ thể).
 *
 * Thin Fastify layer: shapes requests/responses, wires auth + RBAC, and
 * delegates to `PartnerService` / `DestinationService`. It mirrors the
 * registration style of `recruitment/documents/routes.ts`.
 *
 * RBAC mapping (no policy-table change needed — see auth/rbac.ts):
 *   - Writes  -> module 'settings'  / 'update' (ADMIN-only; SALES denied → 403).
 *   - Reads   -> module 'lead_management' / 'read' (ADMIN full; SALES allowed,
 *                and since these collections carry no ownerUserId the SALES
 *                assigned-only scoping does not restrict them).
 *
 * Uses the `/api/v1` gateway prefix. All routes mount behind requireAuth +
 * rbacGuard. This file is additive; `app.ts` wiring is handled separately.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard } from '../http/authMiddleware';
import { PartnerService } from './partnerService';
import type { CreatePartnerInput, UpdatePartnerInput } from './partnerService';
import { DestinationService } from './destinationService';
import type { CreateDestinationInput, UpdateDestinationInput } from './destinationService';

export interface PartnerRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
}

interface IdParams {
  id: string;
}

/** Narrow an unknown value to a non-empty string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Narrow an unknown value to a positive int, else the fallback. */
function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Narrow an unknown value to a boolean, accepting JSON-ish string forms. */
function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === '1';
}

export async function registerPartnerRoutes(
  app: FastifyInstance,
  deps: PartnerRouteDeps,
): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const partnerService = new PartnerService(prisma);
  const destinationService = new DestinationService(prisma);

  // Writes are ADMIN-only (settings/update); reads map to lead_management/read
  // so SALES can read but not mutate. Neither carries an ownerUserId.
  const writeGuard = rbacGuard(() => ({ module: 'settings', action: 'update' }));
  const readGuard = rbacGuard(() => ({ module: 'lead_management', action: 'read' }));

  // ---- Partners (đối tác đã hợp tác) ----------------------------------------
  app.post(
    '/api/v1/partners',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const partner = await partnerService.create((request.body ?? {}) as CreatePartnerInput);
      return reply.code(201).send(partner);
    },
  );

  app.get(
    '/api/v1/partners',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await partnerService.list(
        {
          type: asString(q.type),
          country: asString(q.country),
          status: asString(q.status),
        },
        asInt(q.page, 1),
        asInt(q.limit, 20),
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/v1/partners/:id',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const partner = await partnerService.get(id);
      return reply.code(200).send(partner);
    },
  );

  app.put(
    '/api/v1/partners/:id',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const partner = await partnerService.update(id, (request.body ?? {}) as UpdatePartnerInput);
      return reply.code(200).send(partner);
    },
  );

  app.post(
    '/api/v1/partners/:id/status',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const partner = await partnerService.setStatus(id, asString(body.status) ?? '');
      return reply.code(200).send(partner);
    },
  );

  // ---- Destination programs (nơi có thể đưa đi + điều kiện) ------------------
  app.post(
    '/api/v1/destinations',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const program = await destinationService.create(
        (request.body ?? {}) as CreateDestinationInput,
      );
      return reply.code(201).send(program);
    },
  );

  app.get(
    '/api/v1/destinations',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await destinationService.list(
        {
          country: asString(q.country),
          status: asString(q.status),
          activeOnly: asBool(q.activeOnly),
        },
        asInt(q.page, 1),
        asInt(q.limit, 20),
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/v1/destinations/:id',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const program = await destinationService.get(id);
      return reply.code(200).send(program);
    },
  );

  app.put(
    '/api/v1/destinations/:id',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const program = await destinationService.update(
        id,
        (request.body ?? {}) as UpdateDestinationInput,
      );
      return reply.code(200).send(program);
    },
  );

  app.post(
    '/api/v1/destinations/:id/active',
    { preHandler: [auth, writeGuard] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const program = await destinationService.setActive(id, asBool(body.active));
      return reply.code(200).send(program);
    },
  );
}
