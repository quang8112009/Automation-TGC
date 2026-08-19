/**
 * Brand-template + generated-asset route registration (customer: Thanh Giang).
 *
 * All routes sit behind Foundation auth + RBAC for module 'generation' (ADMIN
 * read/write; SALES has no access). This file is ADDITIVE — it exports a
 * registrar that the application can call without touching routes/index.ts.
 *
 * SECURITY: All request bodies and params are validated through Zod schemas
 * before reaching business logic. Unknown fields are stripped, strings are
 * trimmed and length-capped, and enums are closed sets.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import type { Action, Module } from '../../auth/rbac';
import { requireAuth, rbacGuard } from '../../http/authMiddleware';
import {
  validateBody,
  validateQuery,
  validateParams,
  UUID,
  AssetKindEnum,
  MarketEnum,
  TrimmedString,
  OptionalString,
} from '../../http/validation';
import { BrandTemplateService } from './brandTemplateService';
import { AssetGenerator } from './assetGenerator';
import type { AssetCopy, RenderProvider } from './assetGenerator';

export interface AssetRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional render provider seam; absent in Phase 1 (assets stay SPEC_READY). */
  renderProvider?: RenderProvider;
}

function guard(module: Module, action: Action) {
  return rbacGuard(() => ({ module, action }));
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

const IdParamsSchema = z.object({ id: UUID });

const BrandTemplateBodySchema = z.object({
  name: TrimmedString(100),
  kind: TrimmedString(50),
  spec: z.unknown(),
  active: z.boolean().optional(),
});

const BrandTemplateUpdateBodySchema = z.object({
  name: TrimmedString(100).optional(),
  spec: z.unknown().optional(),
  active: z.boolean().optional(),
});

const BrandTemplateQuerySchema = z.object({
  kind: OptionalString(50),
  activeOnly: z.coerce.boolean().optional(),
});

const DraftAssetBodySchema = z.object({
  draftId: UUID,
  kind: AssetKindEnum,
  templateId: UUID.optional(),
});

const StandaloneAssetBodySchema = z.object({
  kind: AssetKindEnum,
  title: TrimmedString(200),
  body: z.string().trim().max(2000).default(''),
  ctas: z.array(z.string().trim().max(100).min(1)).max(5).default([]),
  market: MarketEnum.optional(),
  templateId: UUID.optional(),
});

const BatchRenderItemSchema = z.object({
  kind: AssetKindEnum,
  title: TrimmedString(200),
  body: z.string().trim().max(2000).default(''),
  ctas: z.array(z.string().trim().max(100).min(1)).max(5).default([]),
  market: MarketEnum.optional(),
  draftId: UUID.optional(),
  templateId: UUID.optional(),
});

const BatchRenderBodySchema = z.object({
  items: z.array(BatchRenderItemSchema).min(1).max(20),
  concurrency: z.number().int().min(1).max(10).default(4),
});

const AssetListQuerySchema = z.object({
  draftId: UUID.optional(),
});

// ── Route registration ──────────────────────────────────────────────────────

export async function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): Promise<void> {
  const { prisma, jwt } = deps;
  const auth = requireAuth({ prisma, jwt });
  const templates = new BrandTemplateService(prisma);
  const generator = new AssetGenerator(prisma, deps.renderProvider);

  // ---- Brand templates -------------------------------------------------------

  app.post(
    '/api/v1/brand-templates',
    { preHandler: [auth, guard('generation', 'create'), validateBody(BrandTemplateBodySchema)] },
    async (request, reply) => {
      const body = (request as unknown as { validatedBody: z.infer<typeof BrandTemplateBodySchema> }).validatedBody;
      const tpl = await templates.create({
        name: body.name,
        kind: body.kind,
        spec: body.spec,
        active: body.active,
      });
      return reply.code(201).send(tpl);
    },
  );

  app.get(
    '/api/v1/brand-templates',
    { preHandler: [auth, guard('generation', 'read'), validateQuery(BrandTemplateQuerySchema)] },
    async (request, reply) => {
      const q = (request as unknown as { validatedQuery: z.infer<typeof BrandTemplateQuerySchema> }).validatedQuery;
      const list = await templates.list({
        kind: q.kind,
        activeOnly: q.activeOnly,
      });
      return reply.code(200).send({ items: list });
    },
  );

  app.get(
    '/api/v1/brand-templates/:id',
    { preHandler: [auth, guard('generation', 'read'), validateParams(IdParamsSchema)] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const tpl = await templates.get(id);
      return reply.code(200).send(tpl);
    },
  );

  app.put(
    '/api/v1/brand-templates/:id',
    { preHandler: [auth, guard('generation', 'update'), validateParams(IdParamsSchema), validateBody(BrandTemplateUpdateBodySchema)] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const body = (request as unknown as { validatedBody: z.infer<typeof BrandTemplateUpdateBodySchema> }).validatedBody;
      const tpl = await templates.update(id, {
        name: body.name,
        spec: body.spec,
        active: body.active,
      });
      return reply.code(200).send(tpl);
    },
  );

  app.post(
    '/api/v1/brand-templates/:id/deactivate',
    { preHandler: [auth, guard('generation', 'update'), validateParams(IdParamsSchema)] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const tpl = await templates.deactivate(id);
      return reply.code(200).send(tpl);
    },
  );

  // ---- Generated assets ------------------------------------------------------

  app.post(
    '/api/v1/assets/from-draft',
    { preHandler: [auth, guard('generation', 'create'), validateBody(DraftAssetBodySchema)] },
    async (request, reply) => {
      const body = (request as unknown as { validatedBody: z.infer<typeof DraftAssetBodySchema> }).validatedBody;
      const asset = await generator.generateForDraft(body.draftId, body.kind, {
        templateId: body.templateId,
      });
      return reply.code(201).send(asset);
    },
  );

  app.post(
    '/api/v1/assets/standalone',
    { preHandler: [auth, guard('generation', 'create'), validateBody(StandaloneAssetBodySchema)] },
    async (request, reply) => {
      const body = (request as unknown as { validatedBody: z.infer<typeof StandaloneAssetBodySchema> }).validatedBody;
      const copy: AssetCopy = {
        title: body.title,
        body: body.body,
        ctas: body.ctas,
        market: body.market,
      };
      const asset = await generator.generateStandalone(body.kind, copy, {
        templateId: body.templateId,
      });
      return reply.code(201).send(asset);
    },
  );

  // ---- Batch generate + render ─────────────────────────────────────────────

  app.post(
    '/api/v1/assets/batch',
    { preHandler: [auth, guard('generation', 'create'), validateBody(BatchRenderBodySchema)] },
    async (request, reply) => {
      const body = (request as unknown as { validatedBody: z.infer<typeof BatchRenderBodySchema> }).validatedBody;
      const items = body.items.map((raw) => ({
        kind: raw.kind,
        copy: {
          title: raw.title,
          body: raw.body,
          ctas: raw.ctas,
          market: raw.market,
        } as AssetCopy,
        draftId: raw.draftId,
        opts: { templateId: raw.templateId },
      }));

      const results = await generator.generateBatch(items, body.concurrency);
      return reply.code(201).send({ items: results });
    },
  );

  app.get(
    '/api/v1/assets',
    { preHandler: [auth, guard('generation', 'read'), validateQuery(AssetListQuerySchema)] },
    async (request, reply) => {
      const q = (request as unknown as { validatedQuery: z.infer<typeof AssetListQuerySchema> }).validatedQuery;
      const list = await generator.list(q.draftId);
      return reply.code(200).send({ items: list });
    },
  );

  app.get(
    '/api/v1/assets/:id',
    { preHandler: [auth, guard('generation', 'read'), validateParams(IdParamsSchema)] },
    async (request, reply) => {
      const { id } = (request as unknown as { validatedParams: { id: string } }).validatedParams;
      const asset = await generator.get(id);
      return reply.code(200).send(asset);
    },
  );
}
