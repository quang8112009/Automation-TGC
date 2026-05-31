/**
 * Asset_Generator — turn a brand template + resolved copy into a deterministic
 * RENDER SPEC and persist it as a GeneratedAsset (customer: Thanh Giang, XKLĐ).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY / SCOPE NOTE (read me):
 *   This module does NOT synthesize pixels. No image/video generation provider
 *   is configured in Phase 1 (no API key). "AI tự tạo hình ảnh/video" is
 *   implemented as SPEC GENERATION:
 *     1. A BrandTemplate describes HOW an asset should look (palette/fonts/logo
 *        + layout slots).
 *     2. `resolveRenderSpec` deterministically fills those slots with the copy
 *        from a draft (or arbitrary copy) and the per-kind output dimensions.
 *     3. The result is persisted as a GeneratedAsset with status SPEC_READY and
 *        provider 'none' — a complete, render-ready blueprint a designer or a
 *        future provider can turn into an actual file.
 *   The optional `RenderProvider` seam lets a real image/video provider render
 *   the spec later; on success the asset becomes RENDERED with a storageKey, on
 *   failure FAILED. We never fabricate fake bytes or claim a render happened.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Prisma } from '@prisma/client';
import type { GeneratedAsset, PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../infra/errors';
import { dimensionsFor, isTemplateKind } from './assetKinds';
import type { AssetKind, Dimensions } from './assetKinds';
import {
  defaultBrandSpec,
  toInputJson,
  validateBrandSpec,
} from './brandTemplateService';
import type {
  BrandFonts,
  BrandLogo,
  BrandPalette,
  BrandSpec,
  LayoutSlot,
} from './brandTemplateService';

// ---- Copy + resolved spec shapes -------------------------------------------

/** The text inputs that fill a render spec's slots. */
export interface AssetCopy {
  title: string;
  body: string;
  ctas?: string[];
  market?: string;
}

/** A layout slot after copy resolution: a name + the concrete text to render. */
export interface ResolvedSlot {
  name: string;
  text: string;
}

/** The deterministic, render-ready blueprint persisted on GeneratedAsset.spec. */
export interface ResolvedRenderSpec {
  kind: AssetKind;
  dimensions: Dimensions;
  palette: BrandPalette;
  fonts: BrandFonts;
  logo: BrandLogo;
  slots: ResolvedSlot[];
}

// ---- Pure helpers (deterministic; unit-tested) -----------------------------

/** Per-kind soft caps for copy-derived (non-headline) slots, in characters. */
const TEXT_CAPS: Readonly<Record<AssetKind, { subhead: number; body: number; cta: number }>> = {
  thumbnail: { subhead: 60, body: 0, cta: 24 },
  poster: { subhead: 90, body: 240, cta: 32 },
  infographic: { subhead: 120, body: 400, cta: 32 },
  short_video: { subhead: 80, body: 0, cta: 24 },
  image: { subhead: 80, body: 200, cta: 24 },
};

/** Deterministic, length-bounded truncation (no ellipsis to stay byte-stable). */
function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  const s = text ?? '';
  return s.length <= max ? s : s.slice(0, max);
}

/** First "excerpt" of body text (up to the first sentence break), then capped. */
function excerpt(body: string, max: number): string {
  const s = (body ?? '').trim();
  if (s.length === 0) return '';
  const breakIdx = s.search(/[.!?\n]/);
  const head = breakIdx > 0 ? s.slice(0, breakIdx) : s;
  return truncate(head.trim(), max);
}

/** Footer line: market-aware, falling back to the brand tagline. */
function footerText(copy: AssetCopy): string {
  const market = typeof copy.market === 'string' ? copy.market.trim() : '';
  return market.length > 0
    ? `Thanh Giang • Thị trường ${market}`
    : 'Thanh Giang • Xuất khẩu lao động';
}

/** Resolve the text for a single slot role from the copy, capped for the kind. */
function resolveSlotText(role: LayoutSlot['role'], copy: AssetCopy, kind: AssetKind): string {
  const caps = TEXT_CAPS[kind] ?? TEXT_CAPS.image;
  switch (role) {
    case 'headline':
      // Headline is the copy title VERBATIM (never truncated) so the resolved
      // spec round-trips the source title exactly.
      return copy.title ?? '';
    case 'subhead':
      return excerpt(copy.body, caps.subhead);
    case 'body':
      return truncate((copy.body ?? '').trim(), caps.body);
    case 'cta': {
      const first = Array.isArray(copy.ctas) ? copy.ctas.find((c) => typeof c === 'string' && c.trim().length > 0) : undefined;
      return first ? truncate(first.trim(), caps.cta) : '';
    }
    case 'footer':
      return footerText(copy);
    case 'logo':
    case 'background':
    default:
      // Visual-only slots carry no text.
      return '';
  }
}

/**
 * A complete BrandSpec for ANY asset kind. Template kinds reuse
 * `defaultBrandSpec`; the plain 'image' kind (which has no BrandTemplate kind)
 * gets a simple, on-brand fallback spec.
 */
export function fallbackBrandSpec(kind: AssetKind): BrandSpec {
  if (isTemplateKind(kind)) {
    return defaultBrandSpec(kind);
  }
  // 'image' fallback
  return validateBrandSpec({
    layoutSlots: [
      { name: 'background', role: 'background' },
      { name: 'logo', role: 'logo' },
      { name: 'headline', role: 'headline' },
      { name: 'subhead', role: 'subhead' },
      { name: 'cta', role: 'cta' },
    ],
  });
}

/**
 * PURE: resolve a deterministic render spec from a kind, a brand spec, and copy.
 * Guarantees: correct per-kind dimensions; a non-empty slots array that always
 * contains a 'headline' slot whose text === copy.title; palette/fonts/logo are
 * always present (normalized from the brand spec).
 */
export function resolveRenderSpec(
  kind: AssetKind,
  brandSpec: unknown,
  copy: AssetCopy,
): ResolvedRenderSpec {
  const normalized = validateBrandSpec(brandSpec);

  // Ensure we have layout slots; fall back to a kind-appropriate default.
  let slots: LayoutSlot[] =
    normalized.layoutSlots.length > 0 ? normalized.layoutSlots : fallbackBrandSpec(kind).layoutSlots;

  // Guarantee a headline slot exists so the spec always carries the title.
  if (!slots.some((s) => s.role === 'headline')) {
    slots = [{ name: 'headline', role: 'headline' }, ...slots];
  }

  const resolvedSlots: ResolvedSlot[] = slots.map((s) => ({
    name: s.name,
    text: resolveSlotText(s.role, copy, kind),
  }));

  return {
    kind,
    dimensions: dimensionsFor(kind),
    palette: normalized.palette,
    fonts: normalized.fonts,
    logo: normalized.logo,
    slots: resolvedSlots,
  };
}

/** PURE: a deterministic, human-readable prompt/brief describing the asset. */
export function assetPromptText(kind: AssetKind, copy: AssetCopy): string {
  const { width, height } = dimensionsFor(kind);
  const parts: string[] = [];
  parts.push(`Thanh Giang XKLĐ brand ${kind} (${width}x${height}).`);
  parts.push(`Headline: "${(copy.title ?? '').trim()}".`);
  const sub = excerpt(copy.body, 120);
  if (sub.length > 0) parts.push(`Subhead: "${sub}".`);
  const cta = Array.isArray(copy.ctas)
    ? copy.ctas.find((c) => typeof c === 'string' && c.trim().length > 0)
    : undefined;
  if (cta) parts.push(`CTA: "${cta.trim()}".`);
  const market = typeof copy.market === 'string' ? copy.market.trim() : '';
  if (market.length > 0) parts.push(`Market: ${market}.`);
  return parts.join(' ');
}

// ---- Render provider seam ---------------------------------------------------

/** What a real image/video provider returns after rendering a spec to a file. */
export interface RenderOutput {
  storageKey: string;
  mimeType: string;
}

/**
 * The optional seam. In Phase 1 NO provider is supplied, so assets stay
 * SPEC_READY. A later provider implements `render` to turn the spec into an
 * actual file (writing it the mediaService way) and returns its storage key.
 */
export interface RenderProvider {
  /** Provider identifier recorded on the asset (e.g. 'replicate', 'ffmpeg'). */
  readonly name?: string;
  render(spec: ResolvedRenderSpec): Promise<RenderOutput>;
}

// ---- Generator --------------------------------------------------------------

export interface GenerateOptions {
  /** Force a specific BrandTemplate; otherwise the active default for the kind. */
  templateId?: string;
}

interface PreparedSpec {
  spec: ResolvedRenderSpec;
  prompt: string;
  templateId: string | null;
}

export class AssetGenerator {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly renderProvider?: RenderProvider,
  ) {}

  /** Generate a spec (and optionally render it) for a draft's copy; 404 if missing. */
  async generateForDraft(
    draftId: string,
    kind: AssetKind,
    opts: GenerateOptions = {},
  ): Promise<GeneratedAsset> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: draftId },
      include: { ctas: true },
    });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }

    const copy: AssetCopy = {
      title: draft.title,
      body: draft.body,
      ctas: draft.ctas.map((c) => c.ctaText),
      market: draft.market ?? undefined,
    };

    const prepared = await this.prepare(kind, copy, opts);
    return this.persistAndMaybeRender(prepared, kind, draftId);
  }

  /** Generate a spec (and optionally render it) from arbitrary copy (no draft). */
  async generateStandalone(
    kind: AssetKind,
    copy: AssetCopy,
    opts: GenerateOptions = {},
  ): Promise<GeneratedAsset> {
    const prepared = await this.prepare(kind, copy, opts);
    return this.persistAndMaybeRender(prepared, kind, null);
  }

  /** List generated assets, optionally scoped to a draft. */
  async list(draftId?: string): Promise<GeneratedAsset[]> {
    const where: Prisma.GeneratedAssetWhereInput = {};
    if (draftId !== undefined) {
      where.draftId = draftId;
    }
    return this.prisma.generatedAsset.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Fetch one generated asset; 404 if missing. */
  async get(id: string): Promise<GeneratedAsset> {
    const asset = await this.prisma.generatedAsset.findUnique({ where: { id } });
    if (!asset) {
      throw new NotFoundError('Generated asset not found', 'GENERATED_ASSET_NOT_FOUND');
    }
    return asset;
  }

  /** Mark an asset RENDERED with the produced file's storage key (async provider). */
  async markRendered(
    id: string,
    storageKey: string,
    mimeType: string,
    provider?: string,
  ): Promise<GeneratedAsset> {
    await this.get(id); // 404 guard
    return this.prisma.generatedAsset.update({
      where: { id },
      data: {
        status: 'RENDERED',
        storageKey,
        mimeType,
        provider: provider ?? 'render-provider',
      },
    });
  }

  /** Mark an asset FAILED (provider error); no fake artifact is stored. */
  async markFailed(id: string): Promise<GeneratedAsset> {
    await this.get(id); // 404 guard
    return this.prisma.generatedAsset.update({
      where: { id },
      data: { status: 'FAILED' },
    });
  }

  // ---- internals ------------------------------------------------------------

  /** Resolve the brand spec (from a chosen/default template or a fallback). */
  private async prepare(
    kind: AssetKind,
    copy: AssetCopy,
    opts: GenerateOptions,
  ): Promise<PreparedSpec> {
    let brandSpec: BrandSpec;
    let templateId: string | null = null;

    if (opts.templateId) {
      const tpl = await this.prisma.brandTemplate.findUnique({ where: { id: opts.templateId } });
      if (!tpl) {
        throw new NotFoundError('Brand template not found', 'BRAND_TEMPLATE_NOT_FOUND');
      }
      brandSpec = validateBrandSpec(tpl.spec);
      templateId = tpl.id;
    } else if (isTemplateKind(kind)) {
      const tpl = await this.prisma.brandTemplate.findFirst({
        where: { kind, active: true },
        orderBy: { createdAt: 'desc' },
      });
      if (tpl) {
        brandSpec = validateBrandSpec(tpl.spec);
        templateId = tpl.id;
      } else {
        brandSpec = fallbackBrandSpec(kind);
      }
    } else {
      brandSpec = fallbackBrandSpec(kind);
    }

    const spec = resolveRenderSpec(kind, brandSpec, copy);
    const prompt = assetPromptText(kind, copy);
    return { spec, prompt, templateId };
  }

  /**
   * Persist the GeneratedAsset (SPEC_READY/none). If a render provider is wired,
   * attempt the render and transition to RENDERED, or FAILED on provider error.
   */
  private async persistAndMaybeRender(
    prepared: PreparedSpec,
    kind: AssetKind,
    draftId: string | null,
  ): Promise<GeneratedAsset> {
    const asset = await this.prisma.generatedAsset.create({
      data: {
        draftId,
        kind,
        templateId: prepared.templateId,
        prompt: prepared.prompt,
        spec: toInputJson(prepared.spec),
        status: 'SPEC_READY',
        provider: 'none',
      },
    });

    if (!this.renderProvider) {
      return asset;
    }

    try {
      const out = await this.renderProvider.render(prepared.spec);
      return this.markRendered(asset.id, out.storageKey, out.mimeType, this.renderProvider.name);
    } catch {
      // Provider failed — record FAILED, never fabricate a fake artifact.
      return this.markFailed(asset.id);
    }
  }
}
