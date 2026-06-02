/**
 * AI Document OCR & Verification route registration (Feature 1).
 *
 * Thin Fastify layer: shapes requests/responses, wires auth + RBAC, and
 * delegates to `DocExtractionService`. Mirrors the registration style and the
 * SALES assigned-only pattern of `recruitment/documents/routes.ts`:
 *
 *   - The candidate-scoped LIST route (`/api/v1/candidates/:id/doc-extractions`)
 *     resolves `ownerUserId` from the candidate's `assignedTo` via a
 *     `candidateTargetById`-style `rbacGuard` builder, under module
 *     'lead_management'/'read'. So ADMIN has full access and SALES is restricted
 *     to assigned candidates (non-assigned → 403).
 *   - SUBMIT (POST /doc-extractions) and GET-by-id map to lead_management
 *     update|read with a static guard; the candidate-scoping is then enforced in
 *     the service (which loads the candidate's `assignedTo` / resolves the
 *     candidate from the row).
 *
 * Uses the `/api/v1` gateway prefix. All routes mount behind requireAuth +
 * rbacGuard. This file is additive; `app.ts` wiring is handled separately.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import type { Action } from '../auth/rbac';
import { DocExtractionService } from './docExtractionService';
import type { SubmitDocInput } from './docExtractionService';
import type { OcrProvider } from './ocrProvider';
import type { DocRequirement, DocType } from './docExtraction';

export interface DocExtractionRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional OCR provider seam; when absent the service uses NoopOcrProvider. */
  ocr?: OcrProvider;
}

interface IdParams {
  id: string;
}

/** Narrow an unknown value to a non-empty string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Narrow an unknown value to a finite number, else undefined. */
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const DOC_TYPES: readonly DocType[] = [
  'IELTS',
  'TOEFL',
  'TRANSCRIPT',
  'FINANCIAL',
  'PASSPORT',
  'OTHER',
];

/** Narrow an unknown value to a known DocType, defaulting to 'OTHER'. */
function asDocType(v: unknown): DocType {
  return typeof v === 'string' && (DOC_TYPES as readonly string[]).includes(v)
    ? (v as DocType)
    : 'OTHER';
}

/** Shape an untrusted requirement object into a typed DocRequirement. */
function asRequirement(v: unknown): DocRequirement | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const req: DocRequirement = {};
  const minScore = asNumber(r.minScore);
  if (minScore !== undefined) req.minScore = minScore;
  const minGpa = asNumber(r.minGpa);
  if (minGpa !== undefined) req.minGpa = minGpa;
  const minAmountVndM = asNumber(r.minAmountVndM);
  if (minAmountVndM !== undefined) req.minAmountVndM = minAmountVndM;
  const asOf = asString(r.asOf);
  if (asOf !== undefined) {
    const d = new Date(asOf);
    if (!Number.isNaN(d.getTime())) req.asOf = d;
  }
  return req;
}

export async function registerDocExtractionRoutes(
  app: FastifyInstance,
  deps: DocExtractionRouteDeps,
): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const service = new DocExtractionService(prisma, deps.ocr);

  // For the candidate :id list route, resolve ownerUserId from the candidate's
  // assignedTo so the SALES assigned-only policy is enforced by authorize()
  // (mirrors candidateTargetById in recruitment/documents/routes.ts). A missing
  // candidate yields ownerUserId=undefined: ADMIN still passes the guard and the
  // service then throws a typed 404.
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

  // For submit + get-by-id, map to lead_management/update|read with a static
  // guard and let the service enforce candidate scoping (it loads the
  // candidate's assignedTo / resolves the candidate from the extraction row).
  const submitGuard = rbacGuard(() => ({ module: 'lead_management', action: 'update' }));
  const readGuard = rbacGuard(() => ({ module: 'lead_management', action: 'read' }));

  // POST /api/v1/doc-extractions — submit a document for OCR + verification.
  // lead_management/update; service enforces SALES assigned-only on candidate.
  app.post(
    '/api/v1/doc-extractions',
    { preHandler: [auth, submitGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: SubmitDocInput = {
        candidateId: asString(body.candidateId) ?? '',
        checklistItemId: asString(body.checklistItemId),
        docType: asDocType(body.docType),
        rawText: typeof body.rawText === 'string' ? body.rawText : undefined,
        imageBase64: asString(body.imageBase64),
        mimeType: asString(body.mimeType),
        storageKey: asString(body.storageKey),
        requirement: asRequirement(body.requirement),
      };
      const row = await service.submit(input, actor);
      return reply.code(201).send(row);
    },
  );

  // GET /api/v1/candidates/:id/doc-extractions — list a candidate's extractions.
  // lead_management/read, SALES assigned-only (resolved from the candidate).
  app.get(
    '/api/v1/candidates/:id/doc-extractions',
    { preHandler: [auth, candidateTargetById('read')] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const items = await service.list(id, actor);
      return reply.code(200).send({ items });
    },
  );

  // GET /api/v1/doc-extractions/:id — fetch a single extraction.
  // lead_management/read; service resolves the candidate from the row and
  // enforces SALES assigned-only.
  app.get(
    '/api/v1/doc-extractions/:id',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const row = await service.get(id, actor);
      return reply.code(200).send(row);
    },
  );
}
