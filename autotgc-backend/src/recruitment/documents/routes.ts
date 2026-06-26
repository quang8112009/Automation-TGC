/**
 * Candidate document-checklist + document-catalog route registration
 * (Requirements 13.6, 15.5).
 *
 * Thin Fastify layer: shapes requests/responses, wires auth + RBAC, and
 * delegates to `DocumentChecklistService` / `DocumentCatalogService`. It mirrors
 * the registration style and — crucially — the SALES assigned-only pattern of
 * `recruitment/routes.ts`:
 *
 *   - Candidate-scoped checklist routes (`/api/v1/candidates/:id/documents*`)
 *     resolve `ownerUserId` from the candidate's `assignedTo` via a
 *     `candidateTargetById`-style `rbacGuard` builder, under module
 *     'lead_management'. So ADMIN has full access and SALES is restricted to
 *     assigned candidates (non-assigned → 403). (Req 13.6)
 *   - The item-scoped status route (`/api/v1/documents/:itemId/status`) resolves
 *     the owning candidate's `assignedTo` from the checklist item so the same
 *     assigned-only policy applies. (Req 13.6)
 *   - The catalog routes are gated by the fine-grained 'document_catalog'
 *     module: GET uses 'document_catalog'/'read' and PUT uses
 *     'document_catalog'/'update'. SALES is granted both under the revised RBAC
 *     policy (Req 1.4, 1.5) while ADMIN keeps full access; this keeps the
 *     broader 'settings' surface ADMIN-only. A successful PUT appends a
 *     metadata-only 'DOCUMENT_CATALOG_UPDATED' audit record via the central
 *     oversight emit point (best-effort, Req 7.1, 7.4).
 *
 * Uses the `/api/v1` gateway prefix. All routes mount behind requireAuth +
 * rbacGuard. This file is additive; `app.ts` wiring is task 9.1.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../../http/authMiddleware';
import type { RbacAuditor } from '../../http/authMiddleware';
import type { Action } from '../../auth/rbac';
import type { OversightService } from '../../oversight/oversightService';
import { DocumentChecklistService } from './documentChecklistService';
import type { AddCustomDocInput } from './documentChecklistService';
import { DocumentCatalogService } from './documentCatalogService';
import type { DocTypeDef } from './documentCatalog';

export interface DocumentRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Central oversight emit point; when present, a document verified
   * (VERIFIED) transition fans out one ActivityLog + N notifications. */
  oversight?: OversightService;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

interface IdParams {
  id: string;
}

interface ItemIdParams {
  itemId: string;
}

interface MarketParams {
  market: string;
}

/** Narrow an unknown value to a non-empty string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Narrow an unknown value to a boolean, accepting JSON-ish string forms. */
function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  deps: DocumentRouteDeps,
): Promise<void> {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const checklistService = new DocumentChecklistService(prisma, deps.oversight);
  const catalogService = new DocumentCatalogService(prisma);

  // For candidate :id checklist routes, resolve ownerUserId from the
  // candidate's assignedTo so the SALES assigned-only policy is enforced by
  // authorize() (mirrors candidateTargetById in recruitment/routes.ts). A
  // missing candidate yields ownerUserId=undefined: ADMIN still passes the guard
  // and the service then throws a typed 404.
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

  // For the item-scoped status route, resolve the owning candidate's assignedTo
  // from the checklist item so the same assigned-only policy applies.
  const itemTargetById = (action: Action) =>
    rbacGuard(async (request: FastifyRequest) => {
      const { itemId } = request.params as ItemIdParams;
      const item = await prisma.documentChecklistItem.findUnique({
        where: { id: itemId },
        select: { candidate: { select: { assignedTo: true } } },
      });
      return {
        module: 'lead_management' as const,
        action,
        ownerUserId: item?.candidate?.assignedTo ?? undefined,
      };
    }, auditor);

  // Catalog routes are gated by the fine-grained `document_catalog` module so
  // SALES can manage the per-market default doc set (Req 1.4, 1.5) without
  // gaining the broader `settings` surface (partners-write, privacy/GDPR). GET
  // maps to document_catalog/read and PUT to document_catalog/update; ADMIN
  // keeps full access via the pure RBAC policy.
  const catalogReadGuard = rbacGuard(() => ({ module: 'document_catalog', action: 'read' }), auditor);
  const catalogUpdateGuard = rbacGuard(() => ({ module: 'document_catalog', action: 'update' }), auditor);

  // ---- Candidate document checklist -----------------------------------------
  // GET /api/v1/candidates/:id/documents — list items + completion metric.
  // (Req 13.6) lead_management/read, SALES assigned-only.
  app.get(
    '/api/v1/candidates/:id/documents',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await checklistService.list(id, actor);
      return reply.code(200).send(result);
    },
  );

  // POST /api/v1/candidates/:id/documents/init — initialize from catalog by
  // desiredMarket. lead_management/update, SALES assigned-only.
  app.post(
    '/api/v1/candidates/:id/documents/init',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const items = await checklistService.initForCandidate(id, actor);
      return reply.code(201).send({ items });
    },
  );

  // POST /api/v1/candidates/:id/documents — add a CUSTOM item; blank label after
  // trim → 400 (enforced in the service). lead_management/update, assigned-only.
  app.post(
    '/api/v1/candidates/:id/documents',
    { preHandler: [auth, candidateTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: AddCustomDocInput = {
        label: asString(body.label) ?? '',
        required: asBoolean(body.required),
      };
      const item = await checklistService.addCustom(id, input, actor);
      return reply.code(201).send(item);
    },
  );

  // PUT /api/v1/documents/:itemId/status — update submission status; value
  // outside the four-value enum → 400 (enforced in the service).
  // lead_management/update, SALES assigned-only (resolved from the item).
  app.put(
    '/api/v1/documents/:itemId/status',
    { preHandler: [auth, itemTargetById('update')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { itemId } = request.params as ItemIdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const item = await checklistService.updateStatus(itemId, body.status, actor);
      return reply.code(200).send(item);
    },
  );

  // ---- Document type catalog (ADMIN) ----------------------------------------
  // GET /api/v1/document-catalog/:market — read the default doc set.
  // document_catalog/read (ADMIN + SALES under the revised policy).
  app.get(
    '/api/v1/document-catalog/:market',
    { preHandler: [auth, catalogReadGuard] },
    async (request, reply) => {
      const { market } = request.params as MarketParams;
      const docs = await catalogService.get(market);
      return reply.code(200).send({ market, docs });
    },
  );

  // PUT /api/v1/document-catalog/:market — update the default doc set. Does NOT
  // touch existing checklist items. document_catalog/update (ADMIN + SALES).
  app.put(
    '/api/v1/document-catalog/:market',
    { preHandler: [auth, catalogUpdateGuard] },
    async (request, reply) => {
      const { market } = request.params as MarketParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const docs = (body.docs ?? []) as DocTypeDef[];
      const updated = await catalogService.update(market, docs);

      // After the catalog write commits, append a metadata-only audit record via
      // the central oversight emit point (best-effort; never blocks/breaks the
      // response). Detail carries no document contents — only the market and the
      // number of docs in the updated set (Req 7.1, 7.4).
      const actor = getAuth(request);
      await deps.oversight?.record({
        actorUserId: actor.userId,
        action: 'DOCUMENT_CATALOG_UPDATED',
        targetType: 'document_catalog',
        targetId: market,
        detail: { market, docCount: updated.length },
      });

      return reply.code(200).send({ market, docs: updated });
    },
  );
}
