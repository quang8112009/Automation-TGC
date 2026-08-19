/**
 * Brand-template + generated-asset route registration (customer: Thanh Giang).
 *
 * All routes sit behind Foundation auth + RBAC for module 'generation' (ADMIN
 * read/write; SALES has no access). This file is ADDITIVE — it exports a
 * registrar that the application can call without touching routes/index.ts.
 *
 * HONESTY NOTE: `/assets/*` endpoints return a GeneratedAsset whose status is
 * SPEC_READY (a render-ready blueprint), not a produced image/video file. No
 * pixel synthesis happens until a RenderProvider is wired into AssetGenerator.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import type { Action, Module } from '../../auth/rbac';
import { requireAuth, rbacGuard } from '../../http/authMiddleware';
import { ValidationError } from '../../infra/errors';
import { BrandTemplateService } from './brandTemplateService';
import { AssetGenerator } from './assetGenerator';
import type { AssetCopy, RenderProvider } from './assetGenerator';
import { isAssetKind } from './assetKinds';
import type { AssetKind } from './assetKinds';

export interface AssetRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional render provider seam; absent in Phase 1 (assets stay SPEC_READY). */
  renderProvider?: RenderProvider;
}

interface IdParams {
  id: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

function guard(module: Module, action: Action) {
  return rbacGuard(() => ({ module, action }));
}

function parseAssetKind(v: unknown): AssetKind {
  const kind = asString(v);
  if (!kind || !isAssetKind(kind)) {
    throw new ValidationError(
      'kind must be one of thumbnail|infographic|poster|short_video|image',
      'ASSET_KIND_INVALID',
    );
  }
  return kind;
}

export async function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const templates = new BrandTemplateService(prisma);
  const generator = new AssetGenerator(prisma, deps.renderProvider);

  // ---- Brand templates -------------------------------------------------------
  app.post(
    '/api/v1/brand-templates',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const tpl = await templates.create({
        name: asString(body.name) ?? '',
        kind: asString(body.kind) ?? '',
        spec: body.spec,
        active: body.active === undefined ? undefined : asBool(body.active),
      });
      return reply.code(201).send(tpl);
    },
  );

  app.get(
    '/api/v1/brand-templates',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const list = await templates.list({
        kind: asString(q.kind),
        activeOnly: q.activeOnly === undefined ? undefined : asBool(q.activeOnly),
      });
      return reply.code(200).send({ items: list });
    },
  );

  app.get(
    '/api/v1/brand-templates/:id',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const tpl = await templates.get(id);
      return reply.code(200).send(tpl);
    },
  );

  app.put(
    '/api/v1/brand-templates/:id',
    { preHandler: [auth, guard('generation', 'update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const tpl = await templates.update(id, {
        name: asString(body.name),
        spec: body.spec,
        active: body.active === undefined ? undefined : asBool(body.active),
      });
      return reply.code(200).send(tpl);
    },
  );

  app.post(
    '/api/v1/brand-templates/:id/deactivate',
    { preHandler: [auth, guard('generation', 'update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const tpl = await templates.deactivate(id);
      return reply.code(200).send(tpl);
    },
  );

  // ---- Generated assets ------------------------------------------------------
  app.post(
    '/api/v1/assets/from-draft',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const draftId = asString(body.draftId);
      if (!draftId) {
        throw new ValidationError('draftId is required', 'ASSET_DRAFT_REQUIRED');
      }
      const kind = parseAssetKind(body.kind);
      const asset = await generator.generateForDraft(draftId, kind, {
        templateId: asString(body.templateId),
      });
      return reply.code(201).send(asset);
    },
  );

  app.post(
    '/api/v1/assets/standalone',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const kind = parseAssetKind(body.kind);
      const title = asString(body.title);
      if (!title) {
        throw new ValidationError('title is required', 'ASSET_TITLE_REQUIRED');
      }
      const copy: AssetCopy = {
        title,
        body: asString(body.body) ?? '',
        ctas: asStringArray(body.ctas),
        market: asString(body.market),
      };
      const asset = await generator.generateStandalone(kind, copy, {
        templateId: asString(body.templateId),
      });
      return reply.code(201).send(asset);
    },
  );

  // ---- Batch generate + render ─────────────────────────────────────────────
  app.post(
    '/api/v1/assets/batch',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (rawItems.length === 0) {
        throw new ValidationError('items array is required and must not be empty', 'ASSET_BATCH_EMPTY');
      }
      if (rawItems.length > 20) {
        throw new ValidationError('batch size limited to 20 items', 'ASSET_BATCH_TOO_LARGE');
      }

      const concurrency = typeof body.concurrency === 'number' && body.concurrency > 0
        ? Math.min(Math.floor(body.concurrency), 10)
        : 4;

      const items = rawItems.map((raw: unknown) => {
        const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
        const kind = parseAssetKind(r.kind);
        const title = asString(r.title);
        if (!title) {
          throw new ValidationError('each item requires a title', 'ASSET_BATCH_ITEM_TITLE_REQUIRED');
        }
        return {
          kind,
          copy: {
            title,
            body: asString(r.body) ?? '',
            ctas: asStringArray(r.ctas),
            market: asString(r.market),
          },
          draftId: asString(r.draftId),
          opts: { templateId: asString(r.templateId) },
        };
      });

      const results = await generator.generateBatch(items, concurrency);
      return reply.code(201).send({ items: results });
    },
  );

  app.get(
    '/api/v1/assets',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const list = await generator.list(asString(q.draftId));
      return reply.code(200).send({ items: list });
    },
  );

  app.get(
    '/api/v1/assets/:id',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const asset = await generator.get(id);
      return reply.code(200).send(asset);
    },
  );
}
