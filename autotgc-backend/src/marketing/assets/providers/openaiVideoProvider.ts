/**
 * OpenAiCompatVideoProvider — RenderProvider that turns a ResolvedRenderSpec
 * into an actual MP4 FILE via the YeScale gateway's OpenAI-COMPATIBLE images
 * endpoint (customer: Thanh Giang, XKLĐ).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHAPE (verified against the gateway by live probing):
 *   On YeScale, VIDEO is served through the SAME unified task endpoint as images
 *   — `POST /images/generations` — NOT a Google long-running operation and NOT a
 *   separate `/videos` path (which 404s). Probing the video model on
 *   /images/generations returned 429 "currently overloaded" (i.e. accepted but
 *   busy). So:
 *     Request : POST `${baseUrl}/images/generations`
 *               headers: { Authorization: `Bearer <key>` }
 *               body:    { model, prompt, n: 1 }
 *     Response: OpenAI Images shape `{ data: [{ url?, b64_json? }] }` where the
 *               `url` is a VIDEO (mp4) URL. We GET-download it; if `b64_json` is
 *               present we decode it instead.
 *
 *   It returns the result directly per the OpenAI images contract — there is no
 *   long-poll here. We are TOLERANT of a few alternate field names a gateway
 *   might use (data[0].video_url, top-level url) and of an async task shape
 *   (task_id/id + status): if a url is present we download it, otherwise we
 *   throw a clean 502 rather than hang.
 *
 *   The gateway returns HTTP 429 ("overloaded") intermittently — THEIR capacity,
 *   not our bug. We retry a bounded number of times with injected backoff, then
 *   degrade to a clean AppError(502).
 *
 *   Everything is env-configurable; nothing is hardcoded:
 *     - apiKey  (VEO_API_KEY)  — never hardcoded; from the SecretLoader.
 *     - model   (VEO_MODEL)    — defaults to veo3.1, overridable.
 *     - baseUrl (VEO_BASE_URL) — the gateway `/v1` base.
 *
 *   Graceful degradation — render() THROWS a clean AppError(502) when:
 *     - no apiKey is configured (VIDEO_AI_NOT_CONFIGURED),
 *     - the HTTP call (or its retries) is not ok (VIDEO_AI_REQUEST_FAILED),
 *     - the response carries no usable video url/bytes (VIDEO_AI_BAD_RESPONSE),
 *     - the decoded/downloaded bytes are empty (VIDEO_AI_BAD_RESPONSE).
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
import { buildVideoPrompt } from './renderPrompt';
import {
  DEFAULT_ASSET_RENDER_DIR,
  DEFAULT_MAX_RETRIES,
  backoffMs,
  bodyToBuffer,
  decodeBase64,
  defaultSleep,
  defaultWriteFile,
  type SleepFn,
  type WriteFileFn,
} from './renderShared';

/** Default OpenAI-compatible video model id used when none is configured (overridable). */
export const DEFAULT_OPENAI_VIDEO_MODEL = 'veo3.1';

export interface OpenAiCompatVideoProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  http?: HttpClient;
  storageDir?: string;
  writeFile?: WriteFileFn;
  maxRetries?: number;
  sleep?: SleepFn;
}

export class OpenAiCompatVideoProvider implements RenderProvider {
  readonly name = 'yescale-veo';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl?: string;
  private readonly http: HttpClient;
  private readonly storageDir: string;
  private readonly writeFile: WriteFileFn;
  private readonly maxRetries: number;
  private readonly sleep: SleepFn;

  constructor(opts: OpenAiCompatVideoProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.model =
      opts.model && opts.model.trim().length > 0 ? opts.model.trim() : DEFAULT_OPENAI_VIDEO_MODEL;
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
   * Render the spec to an MP4 file via the OpenAI-compatible images endpoint
   * (which serves video on YeScale). Throws AppError(502) on any failure; never
   * writes a fake artifact. Kept simple + synchronous (no long-poll).
   */
  async render(spec: ResolvedRenderSpec): Promise<RenderOutput> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new AppError(502, 'Video AI not configured', 'VIDEO_AI_NOT_CONFIGURED');
    }
    if (!this.baseUrl) {
      throw new AppError(502, 'Video AI not configured', 'VIDEO_AI_NOT_CONFIGURED');
    }

    const prompt = buildVideoPrompt(spec);
    const res = await this.postWithRetry(prompt);
    const bytes = await this.extractVideoBytes(res.body);

    const storageKey = `assets/short_video/${randomUUID()}.mp4`;
    const fullPath = path.join(this.storageDir, storageKey);
    await this.writeFile(fullPath, bytes);

    return { storageKey, mimeType: 'video/mp4' };
  }

  /**
   * POST to /images/generations, retrying on a transient HTTP 429 ("overloaded")
   * with injected backoff. Throws 502 VIDEO_AI_REQUEST_FAILED on a non-ok final
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
        throw new AppError(502, 'Video AI request failed', 'VIDEO_AI_REQUEST_FAILED');
      }
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt));
        continue;
      }
      break;
    }
    throw new AppError(
      502,
      lastStatus === 429 ? 'Video AI overloaded' : 'Video AI request failed',
      'VIDEO_AI_REQUEST_FAILED',
    );
  }

  /**
   * Extract video bytes from the OpenAI Images response shape. Prefer an inline
   * base64 payload (data[0].b64_json), else download the bytes behind a video
   * url. Tolerant of alternate url field names and of an async task shape
   * (task_id/id + status) that may still carry a url. Throws 502
   * VIDEO_AI_BAD_RESPONSE when no usable url/bytes are present (never hangs).
   */
  private async extractVideoBytes(body: unknown): Promise<Buffer> {
    const first = readPath(body, 'data.0');

    if (isRecord(first)) {
      const b64 = asString(first.b64_json) ?? asString((first as Record<string, unknown>).b64Json);
      if (b64) {
        const bytes = decodeBase64(b64);
        if (bytes.length > 0) return bytes;
      }
      const url =
        asString(first.url) ??
        asString((first as Record<string, unknown>).video_url) ??
        asString((first as Record<string, unknown>).videoUrl);
      if (url) {
        return this.downloadVideo(url);
      }
    }

    // Tolerant fallbacks: a top-level url, or an async task shape carrying a url.
    const topUrl = asString(readPath(body, 'url')) ?? asString(readPath(body, 'video_url'));
    if (topUrl) {
      return this.downloadVideo(topUrl);
    }

    throw new AppError(502, 'Video AI returned no video', 'VIDEO_AI_BAD_RESPONSE');
  }

  /** GET a video URL and return its bytes; 502 on failure or empty body. */
  private async downloadVideo(url: string): Promise<Buffer> {
    let res: HttpResponse;
    try {
      res = await this.http.get(url);
    } catch {
      throw new AppError(502, 'Video AI download failed', 'VIDEO_AI_REQUEST_FAILED');
    }
    if (!res.ok) {
      throw new AppError(502, 'Video AI download failed', 'VIDEO_AI_REQUEST_FAILED');
    }
    const bytes = bodyToBuffer(res.body);
    if (bytes.length === 0) {
      throw new AppError(502, 'Video AI returned empty video', 'VIDEO_AI_BAD_RESPONSE');
    }
    return bytes;
  }
}
