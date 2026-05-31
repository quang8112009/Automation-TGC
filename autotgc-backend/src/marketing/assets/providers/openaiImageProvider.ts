/**
 * OpenAiCompatImageProvider — RenderProvider that turns a ResolvedRenderSpec
 * into an actual image FILE via an OpenAI-COMPATIBLE images endpoint (the
 * YeScale gateway; customer: Thanh Giang, XKLĐ).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHAPE (verified against the gateway by live probing):
 *   Request : POST `${baseUrl}/images/generations`
 *             headers: { Authorization: `Bearer <key>` }
 *             body:    { model, prompt, n: 1 }
 *   Response: OpenAI Images shape `{ data: [{ url?, b64_json? }] }`.
 *             We support BOTH: prefer `b64_json` (decode), else GET-download the
 *             bytes behind `url`.
 *
 *   The gateway returns HTTP 429 ("Model … currently overloaded") intermittently
 *   — that is THEIR capacity, not our bug. We retry a bounded number of times
 *   with backoff (injected sleep so tests are instant), then degrade to a clean
 *   AppError(502).
 *
 *   Everything is env-configurable; nothing is hardcoded:
 *     - apiKey  (GEMINI_IMAGE_API_KEY)   — never hardcoded; from the SecretLoader.
 *     - model   (GEMINI_IMAGE_MODEL)     — defaults to nano-banana-pro, overridable.
 *     - baseUrl (GEMINI_IMAGE_BASE_URL)  — the gateway `/v1` base.
 *
 *   Graceful degradation — render() THROWS a clean AppError(502) when:
 *     - no apiKey is configured (IMAGE_AI_NOT_CONFIGURED),
 *     - the HTTP call (or its retries) is not ok (IMAGE_AI_REQUEST_FAILED),
 *     - the response carries no usable image (IMAGE_AI_BAD_RESPONSE),
 *     - the decoded/downloaded bytes are empty (IMAGE_AI_BAD_RESPONSE).
 *   On any throw AssetGenerator records the asset FAILED. We NEVER write a fake
 *   or empty file and never claim a render happened.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AppError } from '../../../infra/errors';
import { createFetchHttpClient } from '../../../platforms/httpClient';
import type { HttpClient, HttpResponse } from '../../../platforms/httpClient';
import { asString, isRecord, readPath } from '../../../platforms/narrow';
import type { RenderOutput, RenderProvider, ResolvedRenderSpec } from '../assetGenerator';
import { buildImagePrompt } from './renderPrompt';
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

/** Default OpenAI-compatible image model id used when none is configured (overridable). */
export const DEFAULT_OPENAI_IMAGE_MODEL = 'nano-banana-pro';

export interface OpenAiCompatImageProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  http?: HttpClient;
  storageDir?: string;
  writeFile?: WriteFileFn;
  maxRetries?: number;
  sleep?: SleepFn;
}

export class OpenAiCompatImageProvider implements RenderProvider {
  readonly name = 'yescale-image';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl?: string;
  private readonly http: HttpClient;
  private readonly storageDir: string;
  private readonly writeFile: WriteFileFn;
  private readonly maxRetries: number;
  private readonly sleep: SleepFn;

  constructor(opts: OpenAiCompatImageProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.model =
      opts.model && opts.model.trim().length > 0 ? opts.model.trim() : DEFAULT_OPENAI_IMAGE_MODEL;
    this.baseUrl = opts.baseUrl && opts.baseUrl.trim().length > 0 ? opts.baseUrl.trim() : undefined;
    this.http = opts.http ?? createFetchHttpClient();
    this.storageDir =
      opts.storageDir && opts.storageDir.trim().length > 0 ? opts.storageDir : DEFAULT_ASSET_RENDER_DIR;
    this.writeFile = opts.writeFile ?? defaultWriteFile;
    this.maxRetries =
      typeof opts.maxRetries === 'number' && opts.maxRetries >= 0
        ? Math.floor(opts.maxRetries)
        : DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Render the spec to an image file via the OpenAI-compatible images endpoint.
   * Throws AppError(502) on any failure; never writes a fake artifact.
   */
  async render(spec: ResolvedRenderSpec): Promise<RenderOutput> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new AppError(502, 'Image AI not configured', 'IMAGE_AI_NOT_CONFIGURED');
    }
    if (!this.baseUrl) {
      // No gateway base configured -> cannot call the OpenAI-compatible endpoint.
      throw new AppError(502, 'Image AI not configured', 'IMAGE_AI_NOT_CONFIGURED');
    }

    const prompt = buildImagePrompt(spec);
    const res = await this.postWithRetry(prompt);

    const { bytes, mimeType } = await this.extractImage(res.body);

    const ext = imageExtensionForMime(mimeType);
    const storageKey = `assets/${spec.kind}/${randomUUID()}${ext}`;
    const fullPath = path.join(this.storageDir, storageKey);
    await this.writeFile(fullPath, bytes);

    return { storageKey, mimeType };
  }

  /**
   * POST to /images/generations, retrying on a transient HTTP 429 ("overloaded")
   * with injected backoff. Throws 502 IMAGE_AI_REQUEST_FAILED on a non-ok final
   * response or a transport throw.
   */
  private async postWithRetry(prompt: string): Promise<HttpResponse> {
    const url = `${this.baseUrl}/images/generations`;
    const body = { model: this.model, prompt, n: 1 };
    const headers = { authorization: `Bearer ${this.apiKey as string}` };

    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let res: HttpResponse;
      try {
        res = await this.http.post(url, body, { headers });
      } catch {
        throw new AppError(502, 'Image AI request failed', 'IMAGE_AI_REQUEST_FAILED');
      }
      if (res.ok) return res;
      lastStatus = res.status;
      // Only 429 ("overloaded") is treated as transient and retried.
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt));
        continue;
      }
      break;
    }
    throw new AppError(
      502,
      lastStatus === 429 ? 'Image AI overloaded' : 'Image AI request failed',
      'IMAGE_AI_REQUEST_FAILED',
    );
  }

  /**
   * Extract image bytes + mime from the OpenAI Images response shape:
   *   data[0].b64_json  → decode base64 (preferred), or
   *   data[0].url       → GET-download the bytes.
   * Throws 502 IMAGE_AI_BAD_RESPONSE when neither yields usable bytes.
   */
  private async extractImage(body: unknown): Promise<{ bytes: Buffer; mimeType: string }> {
    const first = readPath(body, 'data.0');

    if (isRecord(first)) {
      const b64 = asString(first.b64_json) ?? asString((first as Record<string, unknown>).b64Json);
      if (b64) {
        const bytes = decodeBase64(b64);
        if (bytes.length > 0) {
          return { bytes, mimeType: 'image/png' };
        }
      }
      const url = asString(first.url);
      if (url) {
        return this.downloadImage(url);
      }
    }

    throw new AppError(502, 'Image AI returned no image', 'IMAGE_AI_BAD_RESPONSE');
  }

  /** GET an image URL and return its bytes; 502 on failure or empty body. */
  private async downloadImage(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
    let res: HttpResponse;
    try {
      res = await this.http.get(url);
    } catch {
      throw new AppError(502, 'Image AI download failed', 'IMAGE_AI_REQUEST_FAILED');
    }
    if (!res.ok) {
      throw new AppError(502, 'Image AI download failed', 'IMAGE_AI_REQUEST_FAILED');
    }
    const bytes = bodyToBuffer(res.body);
    if (bytes.length === 0) {
      throw new AppError(502, 'Image AI returned empty image', 'IMAGE_AI_BAD_RESPONSE');
    }
    // Infer mime from the URL extension where possible (default png).
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
