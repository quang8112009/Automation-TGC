/**
 * On-demand asset RENDER route (customer: Thanh Giang — XKLĐ).
 *
 * The customer asked for rendering to happen "khi có lệnh tạo ảnh" (on command).
 * Assets are created as SPEC_READY blueprints (and rendered synchronously inside
 * generate when a provider is wired). This ADDITIVE registrar adds an explicit
 * trigger to (re-)render an EXISTING asset's persisted spec through the media
 * provider:
 *
 *   POST /api/v1/assets/:id/render
 *     - 404 if the asset does not exist,
 *     - 502 'media AI not configured' if no render provider is wired,
 *     - else re-renders the persisted ResolvedRenderSpec and transitions the
 *       asset to RENDERED (storageKey/mimeType) or FAILED — reusing
 *       AssetGenerator.markRendered / markFailed. Returns the updated asset.
 *
 * Behind Foundation auth + RBAC for module 'generation' (ADMIN-only; SALES is
 * denied on generation). Does NOT modify the RenderProvider contract or the
 * AssetGenerator logic.
 *
 * HONESTY NOTE: a successful response means the configured provider actually
 * produced a file. If the provider is unconfigured/unreachable or returns an
 * unusable payload, the asset is recorded FAILED — never faked.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import type { Action, Module } from '../../auth/rbac';
import { requireAuth, rbacGuard } from '../../http/authMiddleware';
import { AppError } from '../../infra/errors';
import { AssetGenerator } from './assetGenerator';
import type { RenderProvider, ResolvedRenderSpec, ResolvedSlot } from './assetGenerator';
import { isAssetKind, dimensionsFor } from './assetKinds';
import type { AssetKind } from './assetKinds';
import { validateBrandSpec } from './brandTemplateService';

export interface AssetRenderRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Media render provider; absent => 502 'media AI not configured' on render. */
  renderProvider?: RenderProvider;
}

interface IdParams {
  id: string;
}

function guard(module: Module, action: Action) {
  return rbacGuard(() => ({ module, action }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce persisted slots (Json) into a clean ResolvedSlot[] (drop malformed). */
function coerceSlots(value: unknown): ResolvedSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: ResolvedSlot[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === 'string' ? raw.name : undefined;
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (name) slots.push({ name, text });
  }
  return slots;
}

/**
 * Rebuild a validated ResolvedRenderSpec from the asset's persisted Json `spec`
 * and its `kind` column. Palette/fonts/logo are normalized via the shared brand
 * validator; dimensions are re-derived from the kind to stay authoritative.
 */
export function specFromAsset(kind: AssetKind, persistedSpec: unknown): ResolvedRenderSpec {
  const r = isRecord(persistedSpec) ? persistedSpec : {};
  const brand = validateBrandSpec({
    palette: r.palette,
    fonts: r.fonts,
    logo: r.logo,
  });
  return {
    kind,
    dimensions: dimensionsFor(kind),
    palette: brand.palette,
    fonts: brand.fonts,
    logo: brand.logo,
    slots: coerceSlots(r.slots),
  };
}

export function registerAssetRenderRoutes(app: FastifyInstance, deps: AssetRenderRouteDeps): void {
  const { prisma, jwt, renderProvider } = deps;
  const auth = requireAuth({ prisma, jwt });
  const generator = new AssetGenerator(prisma, renderProvider);

  app.post(
    '/api/v1/assets/:id/render',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;

      // 404 if missing (AssetGenerator.get throws NotFoundError).
      const asset = await generator.get(id);

      if (!renderProvider) {
        throw new AppError(502, 'media AI not configured', 'MEDIA_AI_NOT_CONFIGURED');
      }

      const kind: AssetKind = isAssetKind(asset.kind) ? asset.kind : 'image';
      const spec = specFromAsset(kind, asset.spec);

      try {
        const out = await renderProvider.render(spec);
        const updated = await generator.markRendered(
          asset.id,
          out.storageKey,
          out.mimeType,
          renderProvider.name,
        );
        return reply.code(200).send(updated);
      } catch {
        // Provider failed — record FAILED, never fabricate a fake artifact.
        const failed = await generator.markFailed(asset.id);
        return reply.code(200).send(failed);
      }
    },
  );
}
