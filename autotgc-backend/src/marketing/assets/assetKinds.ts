/**
 * Asset kinds + per-kind default dimensions for the BRAND-TEMPLATE VISUAL/VIDEO
 * asset domain (customer: Thanh Giang, XKLĐ).
 *
 * Pure module — no Prisma/Fastify imports. Mirrors the data model:
 *   GeneratedAsset.kind ∈ thumbnail|infographic|poster|short_video|image
 *   BrandTemplate.kind  ∈ thumbnail|infographic|poster|short_video
 *
 * HONESTY NOTE: dimensions describe the RENDER SPEC only. No pixels are
 * synthesized here; a configured render provider (later) consumes the spec.
 */

/** All asset kinds a GeneratedAsset can take. */
export type AssetKind = 'thumbnail' | 'infographic' | 'poster' | 'short_video' | 'image';

/** Brand templates only describe these kinds (no plain 'image'). */
export type TemplateKind = 'thumbnail' | 'infographic' | 'poster' | 'short_video';

/** Ordered list of every asset kind (stable for iteration/seeding/tests). */
export const ASSET_KINDS: readonly AssetKind[] = [
  'thumbnail',
  'infographic',
  'poster',
  'short_video',
  'image',
] as const;

/** Ordered list of the kinds that brand templates are defined for. */
export const TEMPLATE_KINDS: readonly TemplateKind[] = [
  'thumbnail',
  'infographic',
  'poster',
  'short_video',
] as const;

/** Width/height of a rendered asset, in pixels. */
export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Default output dimensions per kind. Chosen for common social placements:
 *  - thumbnail    16:9 video thumbnail (YouTube/Facebook link card)
 *  - poster       4:5 portrait (Facebook/feed promotional poster)
 *  - infographic  4:5 portrait (dense vertical infographic)
 *  - short_video  9:16 vertical (TikTok / Reels / Shorts)
 *  - image        1:1 square (generic feed image)
 */
export const DEFAULT_DIMENSIONS: Readonly<Record<AssetKind, Dimensions>> = {
  thumbnail: { width: 1280, height: 720 },
  poster: { width: 1080, height: 1350 },
  infographic: { width: 1080, height: 1350 },
  short_video: { width: 1080, height: 1920 },
  image: { width: 1080, height: 1080 },
} as const;

/** Type guard: is `value` a known AssetKind? */
export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value);
}

/** Type guard: is `value` a kind that brand templates support? */
export function isTemplateKind(value: unknown): value is TemplateKind {
  return typeof value === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(value);
}

/** Default dimensions for a kind (defensively falls back to a square image). */
export function dimensionsFor(kind: AssetKind): Dimensions {
  return DEFAULT_DIMENSIONS[kind] ?? DEFAULT_DIMENSIONS.image;
}
