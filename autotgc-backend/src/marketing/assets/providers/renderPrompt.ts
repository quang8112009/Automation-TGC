/**
 * Render prompt builders — PURE, deterministic text-to-image / text-to-video
 * prompt generation customized for Thanh Giang's XKLĐ (labor-export) brand.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this exists / honesty note:
 *   These functions turn a deterministic `ResolvedRenderSpec` (the "bản thiết
 *   kế" / blueprint) into the natural-language prompt we send to an image/video
 *   generation provider. They are the SINGLE source of the prompt so the design
 *   is always available — persisted on the asset — even when the downstream
 *   provider is unconfigured or fails. They synthesize NO pixels themselves.
 *
 *   Determinism + safety:
 *     - Same `ResolvedRenderSpec` in => byte-identical prompt out (no clocks,
 *       no randomness, no I/O).
 *     - These prompts NEVER contain secrets. They only encode brand identity,
 *       palette hex, fonts, logo position, aspect ratio and the resolved slot
 *       copy. Callers must never inject a key here.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { ResolvedRenderSpec, ResolvedSlot } from '../assetGenerator';
import type { Dimensions } from '../assetKinds';

/** Greatest common divisor for reducing a dimension pair to an aspect ratio. */
function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x === 0 ? 1 : x;
}

/** Human-readable aspect ratio (e.g. "9:16") derived from pixel dimensions. */
export function aspectRatio(dim: Dimensions): string {
  const w = Number.isFinite(dim.width) && dim.width > 0 ? Math.round(dim.width) : 1;
  const h = Number.isFinite(dim.height) && dim.height > 0 ? Math.round(dim.height) : 1;
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/** Find the resolved text for a slot role (by conventional slot name). */
function slotText(slots: ReadonlyArray<ResolvedSlot>, name: string): string {
  const found = slots.find((s) => s.name === name && s.text.trim().length > 0);
  return found ? found.text.trim() : '';
}

/**
 * The headline is the most important on-image text. The resolver always emits a
 * slot named 'headline' whose text is the copy title verbatim, but we fall back
 * defensively to the first non-empty slot text if the convention ever changes.
 */
function headlineOf(spec: ResolvedRenderSpec): string {
  const byName = slotText(spec.slots, 'headline');
  if (byName.length > 0) return byName;
  const firstNonEmpty = spec.slots.find((s) => s.text.trim().length > 0);
  return firstNonEmpty ? firstNonEmpty.text.trim() : '';
}

/** Logo placement phrased for a vision model. */
function logoPlacement(position: string): string {
  switch (position) {
    case 'top-left':
      return 'top-left corner';
    case 'top-right':
      return 'top-right corner';
    case 'bottom-left':
      return 'bottom-left corner';
    case 'bottom-right':
      return 'bottom-right corner';
    case 'center':
      return 'centered';
    default:
      return 'top-right corner';
  }
}

/**
 * Shared Thanh Giang style descriptor reused by both the image and video
 * prompts. Encodes the brand's positioning: a trustworthy Vietnamese
 * labor-export (XKLĐ) consultancy sending workers to Japan, Korea, Germany,
 * Taiwan and similar markets. Pure and deterministic.
 */
export function brandStyleSuffix(): string {
  return [
    'Brand: Thanh Giang, a professional Vietnamese labor-export (XKLĐ) consultancy',
    'that recruits and sends workers and interns abroad to Japan, South Korea, Germany,',
    'Taiwan and other markets.',
    'Visual identity: clean, modern, trustworthy corporate-marketing style;',
    'professional and optimistic; conveys credibility, opportunity and a clear career path.',
    'High production value, sharp focus, good lighting, realistic and respectful depiction',
    'of Vietnamese workers and professionals.',
  ].join(' ');
}

/** Encode the palette hex values for a generation model. */
function paletteClause(spec: ResolvedRenderSpec): string {
  const p = spec.palette;
  return [
    `primary brand color ${p.primary} (navy, trust)`,
    `secondary accent color ${p.secondary} (gold, highlight)`,
    `background ${p.bg}`,
    `text color ${p.text}`,
  ].join(', ');
}

/** Encode the fonts for typography rendering. */
function fontsClause(spec: ResolvedRenderSpec): string {
  return `headline typeface "${spec.fonts.heading}", body typeface "${spec.fonts.body}"`;
}

/** Build the ordered "render this Vietnamese copy as on-image text" clause. */
function copyClause(spec: ResolvedRenderSpec): string {
  const headline = headlineOf(spec);
  const subhead = slotText(spec.slots, 'subhead');
  const body = slotText(spec.slots, 'body');
  const cta = slotText(spec.slots, 'cta');
  const footer = slotText(spec.slots, 'footer');

  const lines: string[] = [];
  if (headline.length > 0) lines.push(`headline text "${headline}"`);
  if (subhead.length > 0) lines.push(`subheading text "${subhead}"`);
  if (body.length > 0) lines.push(`supporting text "${body}"`);
  if (cta.length > 0) lines.push(`call-to-action button text "${cta}"`);
  if (footer.length > 0) lines.push(`footer line "${footer}"`);
  if (lines.length === 0) return 'no on-image text';
  return `Render this exact Vietnamese text legibly as on-image typography: ${lines.join('; ')}`;
}

/** Negative-style guidance shared by image prompts (kept deterministic). */
function negativeStyleClause(): string {
  return [
    'Avoid: visual clutter, busy backgrounds, distorted or misspelled Vietnamese text,',
    'illegible typography, watermarks, stock-photo logos, low resolution, AI artifacts,',
    'extra fingers, warped faces.',
  ].join(' ');
}

/**
 * PURE: build a rich English text-to-image prompt for a Thanh Giang brand
 * asset. English is used because image models prompt better in English, while
 * the on-image COPY stays in its original Vietnamese (quoted verbatim).
 *
 * Deterministic: identical `spec` => identical string. Contains no secrets.
 */
export function buildImagePrompt(spec: ResolvedRenderSpec): string {
  const ratio = aspectRatio(spec.dimensions);
  const parts: string[] = [];

  parts.push(
    `Professional corporate-marketing ${spec.kind.replace('_', ' ')} poster, ${ratio} aspect ratio (${spec.dimensions.width}x${spec.dimensions.height} px).`,
  );
  parts.push(`${brandStyleSuffix()}`);
  parts.push(`Color palette: ${paletteClause(spec)}.`);
  parts.push(`Typography: ${fontsClause(spec)}.`);
  parts.push(`Place the Thanh Giang logo in the ${logoPlacement(spec.logo.position)}.`);
  parts.push(`${copyClause(spec)}.`);
  parts.push(
    'Layout: clear visual hierarchy, generous whitespace, headline dominant, CTA prominent, balanced composition suitable for social media.',
  );
  parts.push(negativeStyleClause());

  return parts.join(' ');
}

/**
 * PURE: build a Veo-style short-video prompt for a Thanh Giang XKLĐ recruitment
 * short. Describes a ~8s vertical 9:16 clip with a 3-beat structure derived from
 * the resolved slots (hook headline → benefit subhead → CTA), brand colors and
 * Vietnamese on-screen captions.
 *
 * Deterministic: identical `spec` => identical string. Contains no secrets.
 */
export function buildVideoPrompt(spec: ResolvedRenderSpec): string {
  const ratio = aspectRatio(spec.dimensions);
  const headline = headlineOf(spec);
  const subhead = slotText(spec.slots, 'subhead');
  const cta = slotText(spec.slots, 'cta');
  const footer = slotText(spec.slots, 'footer');

  const parts: string[] = [];
  parts.push(
    `An upbeat, professional ~8 second vertical ${ratio} short-form recruitment video (mobile-first, TikTok/Reels/Shorts).`,
  );
  parts.push(`${brandStyleSuffix()}`);
  parts.push(`Brand color grade: ${paletteClause(spec)}.`);

  // 3-beat shot list derived from the copy slots.
  const beats: string[] = [];
  if (headline.length > 0) {
    beats.push(
      `Beat 1 (0-3s) — HOOK: dynamic establishing shot of a confident Vietnamese worker/professional abroad; bold on-screen Vietnamese caption "${headline}".`,
    );
  }
  if (subhead.length > 0) {
    beats.push(
      `Beat 2 (3-6s) — BENEFIT: warm scenes of training, departure and a stable career abroad; on-screen Vietnamese caption "${subhead}".`,
    );
  }
  if (cta.length > 0) {
    beats.push(
      `Beat 3 (6-8s) — CALL TO ACTION: Thanh Giang logo lockup with a prominent button; on-screen Vietnamese caption "${cta}".`,
    );
  }
  if (beats.length === 0) {
    beats.push(
      'Single beat: a confident Vietnamese worker abroad with the Thanh Giang logo lockup; clean, optimistic, professional.',
    );
  }
  parts.push(beats.join(' '));

  if (footer.length > 0) {
    parts.push(`Persistent lower-third Vietnamese caption: "${footer}".`);
  }
  parts.push(
    'Style: smooth camera motion, natural lighting, modern motion-graphics captions, optimistic background music, professional voice-over tone.',
  );
  parts.push(
    'Captions must be legible, correctly spelled Vietnamese; avoid clutter, distorted faces and watermarks.',
  );

  return parts.join(' ');
}
