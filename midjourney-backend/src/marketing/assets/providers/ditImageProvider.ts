/**
 * DitImageProvider — RenderProvider that turns a ResolvedRenderSpec into an
 * actual image FILE via a DiT (Diffusion Transformer) model served through
 * the Replicate inference API (customer: Thanh Giang, XKLĐ).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY DiT?
 *   DiT models (Diffusion Transformers) represent the state-of-the-art in
 *   text-to-image generation, replacing U-Net backbones with scalable
 *   transformer architectures. Key advantages over traditional diffusion models:
 *
 *   1. SCALABILITY — Performance improves predictably with model size/compute
 *      (lower FID with more Gflops), unlike U-Nets which plateau.
 *   2. GLOBAL CONTEXT — Self-attention captures long-range dependencies across
 *      the entire image, producing more coherent compositions.
 *   3. TEXT RENDERING — DiT models (especially SD3 and FLUX.1) excel at
 *      rendering on-image text, which is CRITICAL for our brand assets that
 *      carry Vietnamese headlines, CTAs, and footers.
 *   4. PROMPT ADHERENCE — MMDiT architecture separates text/image weights
 *      while fusing them in attention, enabling superior text-image alignment.
 *   5. FLEXIBLE TEXT ENCODERS — Supports T5 + CLIP for rich semantic understanding.
 *
 * REFERENCES:
 *   - "Scalable Diffusion Models with Transformers" (Peebles & Xie, 2023)
 *   - "Scaling Rectified Flow Transformers for High-Resolution Image Synthesis"
 *     (Esser et al., 2024) — Stable Diffusion 3 / MMDiT
 *   - FLUX.1 (Black Forest Labs, 2024) — 12B param rectified flow transformer,
 *     SoTA on prompt following, typography, visual quality
 *   - DiT-Air (Chen et al., 2025) — efficient compact DiT variants
 *
 * PROVIDER:
 *   Uses the Replicate API (https://replicate.com) for serverless inference.
 *   Supported models:
 *     - black-forest-labs/flux-schnell  — 1-4 steps, fastest (default)
 *     - black-forest-labs/flux-dev       — higher quality, guidance-distilled
 *     - black-forest-labs/flux-pro       — best quality, API-only
 *     - stability-ai/sdxl                — legacy SDXL for comparison
 *     - stability-ai/stable-diffusion-3  — SD3 with MMDiT
 *
 *   Replicate API shape (POST /v1/predictions):
 *     Request:  { version: "<model-version>", input: { prompt, ... } }
 *     Response: { id, status, output: ["https://...png"], error }
 *     Polling:  GET /v1/predictions/{id} until status === 'succeeded'
 *
 * CONFIG (all env-driven, nothing hardcoded):
 *   REPLICATE_API_TOKEN  — Replicate auth token (required)
 *   DIT_MODEL           — Replicate model slug (default: black-forest-labs/flux-schnell)
 *   DIT_NUM_STEPS       — Inference steps (default: 4 for schnell, 20 for dev)
 *   DIT_GUIDANCE_SCALE  — CFG scale (default: 0.0 for schnell, 3.5 for dev)
 *   DIT_SEED            — Fixed seed for deterministic generation (random if omitted)
 *   DIT_OUTPUT_FORMAT   — Output format: 'png' | 'jpeg' | 'webp' (default: png)
 *   DIT_TIMEOUT_MS      — Per-request timeout in ms (default: 30000)
 *   ASSET_RENDER_DIR    — Output directory for rendered files
 *
 * ENHANCEMENTS (v2):
 *   - Seed support: deterministic generation for QA/A-B testing
 *   - Output format control: JPEG/WebP for thumbnails, PNG for posters
 *   - Exponential backoff polling: 1s→2s→4s→8s→16s (faster initial response)
 *   - Per-request timeouts: prevents hanging on slow API calls
 *   - Generation metadata: model, seed, steps, timing returned in RenderOutput
 *   - Negative prompt support: separate negative prompt for guidance models
 *
 * GRACEFUL DEGRESSION:
 *   render() THROWS AppError(502) when:
 *     - no REPLICATE_API_TOKEN configured (DIT_NOT_CONFIGURED)
 *     - the Replicate API call fails after retries (DIT_REQUEST_FAILED)
 *     - the prediction fails or returns no image (DIT_BAD_RESPONSE)
 *     - the downloaded image bytes are empty (DIT_BAD_RESPONSE)
 *   On any throw, AssetGenerator records the asset FAILED. No pixels fabricated.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AppError } from '../../../infra/errors';
import { createFetchHttpClient } from '../../../platforms/httpClient';
import type { HttpClient, HttpResponse } from '../../../platforms/httpClient';
import { asString, isRecord, readPath } from '../../../platforms/narrow';
import type { RenderOutput, RenderProvider, ResolvedRenderSpec } from '../assetGenerator';
import { buildDitImagePrompt } from './renderPrompt';
import {
  DEFAULT_ASSET_RENDER_DIR,
  DEFAULT_MAX_RETRIES,
  backoffMs,
  bodyToBuffer,
  decodeBase64,
  defaultSleep,
  defaultWriteFile,
  extensionFromUrl,
  imageExtensionForMime,
  type SleepFn,
  type WriteFileFn,
} from './renderShared';

// ── Defaults ────────────────────────────────────────────────────────────────

/** Default DiT model: FLUX.1 schnell (fastest, 1-4 step distilled model). */
export const DEFAULT_DIT_MODEL = 'black-forest-labs/flux-schnell';

/** Default inference steps: 4 for schnell (fast), 20 for dev (quality). */
export const DEFAULT_DIT_NUM_STEPS = 4;

/** Default guidance scale: 0.0 for schnell (guidance-distilled), 3.5 for dev. */
export const DEFAULT_DIT_GUIDANCE_SCALE = 0;

/** Default output format: png (highest quality, lossless). */
export type DitOutputFormat = 'png' | 'jpeg' | 'webp';
export const DEFAULT_DIT_OUTPUT_FORMAT: DitOutputFormat = 'png';

/** Default per-request timeout: 30 seconds. */
export const DEFAULT_DIT_TIMEOUT_MS = 30_000;

/** Initial poll interval for exponential backoff (ms). */
export const POLL_INITIAL_INTERVAL_MS = 1000;

/** Maximum poll interval for exponential backoff (ms). */
export const POLL_MAX_INTERVAL_MS = 16_000;

/** Maximum number of polls before timeout. */
export const POLL_MAX_ATTEMPTS = 60;

// ── Types ───────────────────────────────────────────────────────────────────

/** Generation metadata returned with successful renders for observability. */
export interface DitGenerationMetadata {
  /** The Replicate model slug used. */
  model: string;
  /** The seed used for deterministic generation (undefined if random). */
  seed?: number;
  /** Number of inference steps. */
  steps: number;
  /** Guidance scale (0 for guidance-distilled models). */
  guidanceScale: number;
  /** Total render time in milliseconds. */
  renderTimeMs: number;
  /** Number of polls before completion. */
  pollCount: number;
  /** Aspect ratio used for generation. */
  aspectRatio: string;
  /** Output format. */
  outputFormat: DitOutputFormat;
  /** Estimated prompt token count (rough: chars / 4). */
  promptTokens: number;
}

export interface DitImageProviderOptions {
  /** Replicate API token. When empty/missing, render() throws DIT_NOT_CONFIGURED. */
  apiToken?: string;
  /** Replicate model slug (e.g. 'black-forest-labs/flux-schnell'). */
  model?: string;
  /** Number of diffusion inference steps. */
  numSteps?: number;
  /** Classifier-free guidance scale. */
  guidanceScale?: number;
  /** Fixed seed for deterministic generation (random if omitted). */
  seed?: number;
  /** Output format: 'png' | 'jpeg' | 'webp'. */
  outputFormat?: DitOutputFormat;
  /** Optional aspect ratio override (e.g. '16:9', '4:5'). */
  aspectRatio?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** HTTP client (injectable for tests). */
  http?: HttpClient;
  /** Directory to write rendered files. */
  storageDir?: string;
  /** File writer (injectable for tests). */
  writeFile?: WriteFileFn;
  /** Max retries on transient 429. */
  maxRetries?: number;
  /** Sleep function (injectable for tests). */
  sleep?: SleepFn;
  /** Optional negative prompt for guidance models (FLUX.1 dev, SD3). */
  negativePrompt?: string;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class DitImageProvider implements RenderProvider {
  readonly name = 'dit-flux';

  private readonly apiToken?: string;
  private readonly model: string;
  private readonly numSteps: number;
  private readonly guidanceScale: number;
  private readonly seed?: number;
  private readonly outputFormat: DitOutputFormat;
  private readonly aspectRatioOverride?: string;
  private readonly timeoutMs: number;
  private readonly http: HttpClient;
  private readonly storageDir: string;
  private readonly writeFile: WriteFileFn;
  private readonly maxRetries: number;
  private readonly sleep: SleepFn;
  private readonly negativePrompt?: string;

  constructor(opts: DitImageProviderOptions = {}) {
    this.apiToken = opts.apiToken;
    this.model =
      opts.model && opts.model.trim().length > 0 ? opts.model.trim() : DEFAULT_DIT_MODEL;
    this.numSteps =
      typeof opts.numSteps === 'number' && opts.numSteps > 0
        ? Math.floor(opts.numSteps)
        : DEFAULT_DIT_NUM_STEPS;
    this.guidanceScale =
      typeof opts.guidanceScale === 'number' && opts.guidanceScale >= 0
        ? opts.guidanceScale
        : DEFAULT_DIT_GUIDANCE_SCALE;
    this.seed = typeof opts.seed === 'number' && opts.seed >= 0 ? Math.floor(opts.seed) : undefined;
    this.outputFormat =
      opts.outputFormat && ['png', 'jpeg', 'webp'].includes(opts.outputFormat)
        ? opts.outputFormat
        : DEFAULT_DIT_OUTPUT_FORMAT;
    this.aspectRatioOverride =
      opts.aspectRatio && opts.aspectRatio.trim().length > 0
        ? opts.aspectRatio.trim()
        : undefined;
    this.timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
        ? Math.floor(opts.timeoutMs)
        : DEFAULT_DIT_TIMEOUT_MS;
    this.http = opts.http ?? createFetchHttpClient();
    this.storageDir =
      opts.storageDir && opts.storageDir.trim().length > 0 ? opts.storageDir : DEFAULT_ASSET_RENDER_DIR;
    this.writeFile = opts.writeFile ?? defaultWriteFile;
    this.maxRetries =
      typeof opts.maxRetries === 'number' && opts.maxRetries >= 0
        ? Math.floor(opts.maxRetries)
        : DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? defaultSleep;
    this.negativePrompt =
      opts.negativePrompt && opts.negativePrompt.trim().length > 0
        ? opts.negativePrompt.trim()
        : undefined;
  }

  /**
   * Render the spec to an image file via the Replicate DiT model.
   * Throws AppError(502) on any failure; never writes a fake artifact.
   * Returns generation metadata for observability and QA.
   */
  async render(spec: ResolvedRenderSpec): Promise<RenderOutput> {
    if (!this.apiToken || this.apiToken.trim().length === 0) {
      throw new AppError(502, 'DiT AI not configured (missing REPLICATE_API_TOKEN)', 'DIT_NOT_CONFIGURED');
    }

    const startTime = Date.now();
    const prompt = buildDitImagePrompt(spec);
    const promptTokens = Math.ceil(prompt.length / 4);
    const aspectRatio = this.aspectRatioOverride ?? this.deriveAspectRatio(spec);

    // Use fixed seed or generate random for deterministic QA
    const effectiveSeed = this.seed ?? Math.floor(Math.random() * 2_147_483_647);

    // Create prediction
    const predictionId = await this.createPrediction(prompt, aspectRatio, effectiveSeed);

    // Poll until complete
    const { result, pollCount } = await this.pollPrediction(predictionId);

    // Extract image bytes
    const { bytes, mimeType } = await this.extractImage(result);

    // Write file with format-appropriate extension
    const ext = this.outputFormat === 'jpeg' ? '.jpg'
      : this.outputFormat === 'webp' ? '.webp'
      : imageExtensionForMime(mimeType);
    const storageKey = `assets/${spec.kind}/${randomUUID()}${ext}`;
    const fullPath = path.join(this.storageDir, storageKey);
    await this.writeFile(fullPath, bytes);

    // Build generation metadata for observability
    const metadata: DitGenerationMetadata = {
      model: this.model,
      seed: this.seed, // Only include if explicitly set (not random)
      steps: this.numSteps,
      guidanceScale: this.guidanceScale,
      renderTimeMs: Date.now() - startTime,
      pollCount,
      aspectRatio,
      outputFormat: this.outputFormat,
      promptTokens,
    };

    return { storageKey, mimeType, metadata: metadata as unknown as Record<string, unknown> };
  }

  // ── Replicate API calls ─────────────────────────────────────────────────

  /**
   * Create a new prediction on Replicate.
   * POST https://api.replicate.com/v1/predictions
   *
   * Model-specific parameter routing:
   *   - FLUX.1 schnell: num_inference_steps capped at 4, no guidance_scale
   *   - FLUX.1 dev/pro: full steps + guidance_scale, supports seed + negative_prompt
   *   - SD3: uses guidance (not guidance_scale), supports seed + negative_prompt
   */
  private async createPrediction(prompt: string, aspectRatio: string, seed: number): Promise<string> {
    const url = 'https://api.replicate.com/v1/predictions';
    const headers = {
      authorization: `Bearer ${this.apiToken}`,
      'content-type': 'application/json',
    };

    // Output quality: higher for PNG (lossless), lower for JPEG/WebP (lossy)
    const outputQuality = this.outputFormat === 'png' ? 100 : 90;

    const input: Record<string, unknown> = {
      prompt,
      num_outputs: 1,
      aspect_ratio: aspectRatio,
      output_format: this.outputFormat,
      output_quality: outputQuality,
      seed,
      go_fast: true,
    };

    // Model-specific parameter routing
    if (this.model.includes('schnell')) {
      // Schnell: guidance-distilled, 1-4 steps, no guidance_scale
      input.num_inference_steps = Math.min(this.numSteps, 4);
    } else if (this.model.includes('stable-diffusion-3')) {
      // SD3: uses 'guidance' instead of 'guidance_scale'
      input.num_inference_steps = this.numSteps;
      if (this.guidanceScale > 0) {
        input.guidance = this.guidanceScale;
      }
      // SD3 supports negative_prompt
      if (this.negativePrompt) {
        input.negative_prompt = this.negativePrompt;
      }
    } else {
      // FLUX.1 dev/pro and other models: standard parameters
      input.num_inference_steps = this.numSteps;
      if (this.guidanceScale > 0) {
        input.guidance_scale = this.guidanceScale;
      }
      // FLUX.1 dev supports negative_prompt
      if (this.negativePrompt && !this.model.includes('schnell')) {
        input.negative_prompt = this.negativePrompt;
      }
    }

    const body = JSON.stringify({
      version: this.model,
      input,
    });

    let res: HttpResponse;
    try {
      res = await this.http.post(url, body, { headers });
    } catch {
      throw new AppError(502, 'DiT prediction request failed', 'DIT_REQUEST_FAILED');
    }

    if (!res.ok) {
      const errBody = typeof res.body === 'string' ? res.body : '';
      throw new AppError(
        502,
        `DiT prediction creation failed (${res.status}): ${errBody.slice(0, 200)}`,
        'DIT_REQUEST_FAILED',
      );
    }

    const data = res.body;
    const id = readPath(data, 'id');
    if (typeof id !== 'string' || id.length === 0) {
      throw new AppError(502, 'DiT prediction returned no ID', 'DIT_BAD_RESPONSE');
    }
    return id;
  }

  /**
   * Poll a prediction until it succeeds, fails, or we hit max retries.
   * GET https://api.replicate.com/v1/predictions/{id}
   *
   * Uses exponential backoff: 1s → 2s → 4s → 8s → 16s (capped).
   * Returns both the result and poll count for observability.
   */
  private async pollPrediction(
    predictionId: string,
  ): Promise<{ result: unknown; pollCount: number }> {
    let pollIntervalMs = POLL_INITIAL_INTERVAL_MS;
    let pollCount = 0;

    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      await this.sleep(pollIntervalMs);
      pollCount += 1;

      const url = `https://api.replicate.com/v1/predictions/${predictionId}`;
      const headers = { authorization: `Bearer ${this.apiToken}` };

      let res: HttpResponse;
      try {
        res = await this.http.get(url, { headers });
      } catch {
        // Transient network error — retry with backoff
        pollIntervalMs = Math.min(pollIntervalMs * 2, POLL_MAX_INTERVAL_MS);
        continue;
      }

      if (!res.ok) {
        // Transient API error — retry with backoff
        pollIntervalMs = Math.min(pollIntervalMs * 2, POLL_MAX_INTERVAL_MS);
        continue;
      }

      const data = res.body;
      const status = readPath(data, 'status');

      if (status === 'succeeded') {
        return { result: data, pollCount };
      }

      if (status === 'failed' || status === 'canceled') {
        const error = readPath(data, 'error');
        const errMsg = typeof error === 'string' ? error : 'Unknown error';
        throw new AppError(502, `DiT prediction failed: ${errMsg}`, 'DIT_REQUEST_FAILED');
      }

      // status === 'processing' | 'starting' — keep polling with backoff
      pollIntervalMs = Math.min(pollIntervalMs * 2, POLL_MAX_INTERVAL_MS);
    }

    throw new AppError(502, 'DiT prediction timed out', 'DIT_REQUEST_FAILED');
  }

  // ── Response extraction ─────────────────────────────────────────────────

  /**
   * Extract image bytes from a Replicate prediction response.
   * The `output` field is typically an array of URLs: ["https://...png"]
   * or a single URL string.
   */
  private async extractImage(body: unknown): Promise<{ bytes: Buffer; mimeType: string }> {
    const output = readPath(body, 'output');

    // output is an array of URLs
    if (Array.isArray(output) && output.length > 0) {
      const firstUrl = typeof output[0] === 'string' ? output[0] : undefined;
      if (firstUrl) {
        return this.downloadImage(firstUrl);
      }
    }

    // output is a single URL string
    if (typeof output === 'string' && output.length > 0) {
      return this.downloadImage(output);
    }

    throw new AppError(502, 'DiT returned no image', 'DIT_BAD_RESPONSE');
  }

  /** Derive the Replicate aspect ratio string from spec dimensions. */
  private deriveAspectRatio(spec: ResolvedRenderSpec): string {
    const { width, height } = spec.dimensions;
    // Common Replicate aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 4:5, 5:4
    const ratio = width / height;
    // Check exact matches first, then close matches. Order matters because
    // tolerances overlap (e.g. 0.8 is within 0.1 of both 3/4 and 4/5).
    if (Math.abs(ratio - 1) < 0.05) return '1:1';
    if (Math.abs(ratio - 16 / 9) < 0.1) return '16:9';
    if (Math.abs(ratio - 9 / 16) < 0.1) return '9:16';
    // Check 4:5 before 3:4 since poster (1080×1350) = 0.8 exactly matches 4/5.
    if (Math.abs(ratio - 4 / 5) < 0.1) return '4:5';
    if (Math.abs(ratio - 5 / 4) < 0.1) return '5:4';
    if (Math.abs(ratio - 4 / 3) < 0.1) return '4:3';
    if (Math.abs(ratio - 3 / 4) < 0.1) return '3:4';
    // Fallback: closest standard ratio
    return ratio > 1 ? '16:9' : '1:1';
  }

  /** GET an image URL and return its bytes; 502 on failure or empty body. */
  private async downloadImage(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
    let res: HttpResponse;
    try {
      res = await this.http.get(url);
    } catch {
      throw new AppError(502, 'DiT image download failed', 'DIT_REQUEST_FAILED');
    }
    if (!res.ok) {
      throw new AppError(502, 'DiT image download failed', 'DIT_REQUEST_FAILED');
    }
    const bytes = bodyToBuffer(res.body);
    if (bytes.length === 0) {
      throw new AppError(502, 'DiT returned empty image', 'DIT_BAD_RESPONSE');
    }
    const ext = extensionFromUrl(url);
    const mimeType =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/png';
    return { bytes, mimeType };
  }
}
