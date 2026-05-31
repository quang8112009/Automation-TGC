/**
 * MediaRenderProvider — a RenderProvider ROUTER that delegates to the right
 * modality provider by `spec.kind` (customer: Thanh Giang, XKLĐ):
 *   - 'short_video'                              → OpenAiCompatVideoProvider (video)
 *   - 'thumbnail'|'infographic'|'poster'|'image' → OpenAiCompatImageProvider (image)
 *
 * Both providers target the OpenAI-COMPATIBLE YeScale gateway (Bearer auth,
 * `/images/generations` — video is served via the SAME endpoint). This is the
 * single RenderProvider wired into AssetGenerator. When a modality is
 * unconfigured its underlying provider throws AppError(502); AssetGenerator
 * then records the asset FAILED. No pixels/bytes are ever fabricated.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONFIG NOTE: `createMediaRenderProvider(secrets)` reads env (via SecretLoader)
 * and returns a MediaRenderProvider, OR `undefined` when NEITHER image nor video
 * is configured — so AssetGenerator stays in SPEC_READY (blueprint-only) mode.
 * All key/model/base-url values are env-driven; nothing is hardcoded:
 *   image → GEMINI_IMAGE_API_KEY / GEMINI_IMAGE_MODEL / GEMINI_IMAGE_BASE_URL
 *   video → VEO_API_KEY          / VEO_MODEL          / VEO_BASE_URL
 *   dir   → ASSET_RENDER_DIR (default `${MEDIA_DIR or ./media}/assets`)
 * The *_BASE_URL values must be the gateway's `/v1` base. When only one modality
 * is configured, the other provider is still constructed (with no key) so
 * calling it degrades to a clean 502 rather than crashing.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as path from 'path';
import type { SecretLoader } from '../../../infra/secrets';
import type { RenderOutput, RenderProvider, ResolvedRenderSpec } from '../assetGenerator';
import { OpenAiCompatImageProvider } from './openaiImageProvider';
import { OpenAiCompatVideoProvider } from './openaiVideoProvider';

export interface MediaRenderProviderDeps {
  /** Handles all image kinds (thumbnail|infographic|poster|image). */
  image: RenderProvider;
  /** Handles the 'short_video' kind. */
  video: RenderProvider;
}

export class MediaRenderProvider implements RenderProvider {
  readonly name = 'gemini-media';

  private readonly image: RenderProvider;
  private readonly video: RenderProvider;

  constructor(deps: MediaRenderProviderDeps) {
    this.image = deps.image;
    this.video = deps.video;
  }

  /** Route to the modality provider for the spec's kind. */
  async render(spec: ResolvedRenderSpec): Promise<RenderOutput> {
    if (spec.kind === 'short_video') {
      return this.video.render(spec);
    }
    return this.image.render(spec);
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
 * modality is configured (so AssetGenerator stays SPEC_READY). When only one
 * modality has a key, the other still throws a clean 502 on use.
 */
export function createMediaRenderProvider(
  secrets: SecretLoader,
  opts: CreateMediaRenderProviderOptions = {},
): MediaRenderProvider | undefined {
  const imageKey = secrets.optional('GEMINI_IMAGE_API_KEY');
  const videoKey = secrets.optional('VEO_API_KEY');

  // Neither modality configured → no provider (assets remain blueprints).
  if (!imageKey && !videoKey) {
    return undefined;
  }

  const storageDir = opts.storageDir ?? resolveRenderDir(secrets);

  const image = new OpenAiCompatImageProvider({
    apiKey: imageKey,
    model: secrets.optional('GEMINI_IMAGE_MODEL'),
    baseUrl: secrets.optional('GEMINI_IMAGE_BASE_URL'),
    storageDir,
  });

  const video = new OpenAiCompatVideoProvider({
    apiKey: videoKey,
    model: secrets.optional('VEO_MODEL'),
    baseUrl: secrets.optional('VEO_BASE_URL'),
    storageDir,
  });

  return new MediaRenderProvider({ image, video });
}
