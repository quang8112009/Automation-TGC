/**
 * MediaRenderProvider — a RenderProvider ROUTER that delegates to the right
 * modality provider by `spec.kind` (customer: Thanh Giang, XKLĐ):
 *   - 'short_video'                              → OpenAiCompatVideoProvider (video)
 *   - 'thumbnail'|'infographic'|'poster'|'image' → DiTImageProvider (primary) OR
 *                                                   OpenAiCompatImageProvider (fallback)
 *
 * DiT (Diffusion Transformer) providers are now the PREFERRED image backend:
 *   - FLUX.1 (Black Forest Labs) — 12B param rectified flow transformer, SoTA
 *     on prompt following, typography, visual quality. Available via Replicate API.
 *   - Stable Diffusion 3 — MMDiT architecture with flow matching, excellent text
 *     rendering. Available via Replicate/HuggingFace.
 *
 * The OpenAI-compatible YeScale gateway is kept as a FALLBACK when DiT is
 * unconfigured. This ensures backward compatibility while enabling the DiT upgrade.
 *
 * CONFIG (env-driven, nothing hardcoded):
 *   DiT (preferred):
 *     REPLICATE_API_TOKEN  — Replicate auth token (enables DiT)
 *     DIT_MODEL           — model slug (default: black-forest-labs/flux-schnell)
 *     DIT_NUM_STEPS       — inference steps (default: 4 for schnell)
 *     DIT_GUIDANCE_SCALE  — CFG scale (default: 0 for schnell)
 *   Fallback (OpenAI-compat):
 *     GEMINI_IMAGE_API_KEY / GEMINI_IMAGE_MODEL / GEMINI_IMAGE_BASE_URL
 *   Video (unchanged):
 *     VEO_API_KEY / VEO_MODEL / VEO_BASE_URL
 *   Shared:
 *     ASSET_RENDER_DIR (default `${MEDIA_DIR or ./media}/assets`)
 *
 * When NEITHER DiT NOR OpenAI-compat image is configured, assets stay SPEC_READY.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as path from 'path';
import type { SecretLoader } from '../../../infra/secrets';
import type { RenderOutput, RenderProvider, ResolvedRenderSpec } from '../assetGenerator';
import { DitImageProvider } from './ditImageProvider';
import { OpenAiCompatImageProvider } from './openaiImageProvider';
import { OpenAiCompatVideoProvider } from './openaiVideoProvider';

export interface MediaRenderProviderDeps {
  /** Handles all image kinds (thumbnail|infographic|poster|image). */
  image: RenderProvider;
  /** Handles the 'short_video' kind. */
  video: RenderProvider;
}

export class MediaRenderProvider implements RenderProvider {
  /**
   * Provider name reflects the active image backend:
   *   'dit-media'    when DiT (FLUX.1/SD3) is configured
   *   'gemini-media' when falling back to OpenAI-compat YeScale
   */
  readonly name: string;

  private readonly image: RenderProvider;
  private readonly video: RenderProvider;

  constructor(deps: MediaRenderProviderDeps) {
    this.image = deps.image;
    this.video = deps.video;
    // Reflect which image backend is active for observability / asset metadata.
    this.name = deps.image.name === 'dit-flux' ? 'dit-media' : 'gemini-media';
  }

  /** Route to the modality provider for the spec's kind. */
  async render(spec: ResolvedRenderSpec): Promise<RenderOutput> {
    if (spec.kind === 'short_video') {
      return this.video.render(spec);
    }
    return this.image.render(spec);
  }

  /**
   * Render multiple specs in parallel. Delegates to the underlying image/video
   * provider's renderBatch if available, otherwise falls back to sequential
   * single renders via the base render() method.
   */
  async renderBatch(
    specs: ResolvedRenderSpec[],
    concurrency: number = 4,
  ): Promise<Array<{ spec: ResolvedRenderSpec; result?: RenderOutput; error?: Error }>> {
    // Check if the image provider supports batch rendering (DitImageProvider does).
    if ('renderBatch' in this.image && typeof (this.image as { renderBatch?: Function }).renderBatch === 'function') {
      // Split specs by modality: images vs videos.
      const imageSpecs = specs.filter((s) => s.kind !== 'short_video');
      const videoSpecs = specs.filter((s) => s.kind === 'short_video');

      const imageResults = imageSpecs.length > 0
        ? await (this.image as { renderBatch(s: ResolvedRenderSpec[], c: number): Promise<Array<{ spec: ResolvedRenderSpec; result?: RenderOutput; error?: Error }>> }).renderBatch(imageSpecs, concurrency)
        : [];

      // Videos don't have batch support yet — render sequentially.
      const videoResults: Array<{ spec: ResolvedRenderSpec; result?: RenderOutput; error?: Error }> = [];
      for (const spec of videoSpecs) {
        try {
          const result = await this.video.render(spec);
          videoResults.push({ spec, result });
        } catch (err) {
          videoResults.push({ spec, error: err instanceof Error ? err : new Error(String(err)) });
        }
      }

      // Merge results back in input order.
      const resultMap = new Map<ResolvedRenderSpec, { spec: ResolvedRenderSpec; result?: RenderOutput; error?: Error }>();
      for (const r of [...imageResults, ...videoResults]) {
        resultMap.set(r.spec, r);
      }
      return specs.map((s) => resultMap.get(s) ?? { spec: s, error: new Error('Missing result') });
    }

    // Fallback: render sequentially.
    const results: Array<{ spec: ResolvedRenderSpec; result?: RenderOutput; error?: Error }> = [];
    for (const spec of specs) {
      try {
        const result = await this.render(spec);
        results.push({ spec, result });
      } catch (err) {
        results.push({ spec, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
    return results;
  }
}

/** Resolve the rendered-asset output directory from env (or a sensible default). */
function resolveRenderDir(secrets: SecretLoader): string {
  const explicit = secrets.optional('ASSET_RENDER_DIR');
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const mediaDir = secrets.optional('MEDIA_DIR');
  const base = mediaDir && mediaDir.trim().length > 0 ? mediaDir.trim() : path.join(process.cwd(), 'media');
  return path.join(base, 'assets');
}

export interface CreateMediaRenderProviderOptions {
  /** Override the rendered-asset output dir (otherwise derived from env). */
  storageDir?: string;
}

/**
 * Build a MediaRenderProvider from env, or return `undefined` when NEITHER
 * modality is configured (so AssetGenerator stays SPEC_READY).
 *
 * PRIORITY: DiT (REPLICATE_API_TOKEN) > OpenAI-compat (GEMINI_IMAGE_API_KEY).
 * When both are configured, DiT wins for image generation (better quality,
 * typography, prompt adherence). OpenAI-compat is kept as fallback.
 */
export function createMediaRenderProvider(
  secrets: SecretLoader,
  opts: CreateMediaRenderProviderOptions = {},
): MediaRenderProvider | undefined {
  const replicateToken = secrets.optional('REPLICATE_API_TOKEN');
  const imageKey = secrets.optional('GEMINI_IMAGE_API_KEY');
  const videoKey = secrets.optional('VEO_API_KEY');

  // Neither DiT nor image nor video configured → no provider.
  if (!replicateToken && !imageKey && !videoKey) {
    return undefined;
  }

  const storageDir = opts.storageDir ?? resolveRenderDir(secrets);

  // ── Image provider: DiT (preferred) or OpenAI-compat (fallback) ──
  let image: RenderProvider;

  if (replicateToken && replicateToken.trim().length > 0) {    // DiT provider: FLUX.1 via Replicate API
    image = new DitImageProvider({
      apiToken: replicateToken,
      model: secrets.optional('DIT_MODEL'),
      numSteps: parseOptionalInt(secrets.optional('DIT_NUM_STEPS')),
      guidanceScale: parseOptionalFloat(secrets.optional('DIT_GUIDANCE_SCALE')),
      seed: parseOptionalInt(secrets.optional('DIT_SEED')),
      outputFormat: parseOptionalOutputFormat(secrets.optional('DIT_OUTPUT_FORMAT')),
      timeoutMs: parseOptionalInt(secrets.optional('DIT_TIMEOUT_MS')),
      negativePrompt: secrets.optional('DIT_NEGATIVE_PROMPT'),
      storageDir,
    });
  } else {
    // Fallback: OpenAI-compatible YeScale gateway
    image = new OpenAiCompatImageProvider({
      apiKey: imageKey,
      model: secrets.optional('GEMINI_IMAGE_MODEL'),
      baseUrl: secrets.optional('GEMINI_IMAGE_BASE_URL'),
      storageDir,
    });
  }

  const video = new OpenAiCompatVideoProvider({
    apiKey: videoKey,
    model: secrets.optional('VEO_MODEL'),
    baseUrl: secrets.optional('VEO_BASE_URL'),
    storageDir,
  });

  return new MediaRenderProvider({ image, video });
}

/** Parse an optional string to integer, returning undefined on failure. */
function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse an optional string to float, returning undefined on failure. */
function parseOptionalFloat(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const n = parseFloat(value.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Parse an optional string to DitOutputFormat, returning undefined on failure. */
function parseOptionalOutputFormat(value: string | undefined): 'png' | 'jpeg' | 'webp' | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'png' || v === 'jpeg' || v === 'webp') return v;
  return undefined;
}
