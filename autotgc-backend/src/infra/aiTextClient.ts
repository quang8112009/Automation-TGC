/**
 * AiTextClient — text generator over an OpenAI-COMPATIBLE chat gateway.
 *
 * Provider-neutral client (formerly `GeminiClient`). The whole system targets an
 * OpenAI-compatible ChatCompletions gateway (currently DeepSeek V4): it
 * authenticates with `Authorization: Bearer <key>` and exposes
 * `POST {baseUrl}/chat/completions` taking `{model, messages:[...]}` and
 * returning the OpenAI shape `{choices:[{message:{content}}]}`.
 *
 * The connection settings now arrive as a normalized {@link AiTextConfig}
 * (`{provider, baseUrl, model, timeout}`); the API key is passed separately and
 * is NEVER logged. When the key OR the base URL is absent the client fails fast
 * with a 502 `AI_NOT_CONFIGURED` rather than calling the API. HTTP is injected
 * for testing.
 *
 * The legacy class name `GeminiClient` is preserved as a compatibility alias so
 * existing imports do not break (see bottom of file).
 */
import { AppError } from './errors';
import { createFetchHttpClient } from '../platforms/httpClient';
import type { HttpClient } from '../platforms/httpClient';
import { asString, isRecord, readPath } from '../platforms/narrow';
import { AI_TEXT_DEFAULT_TIMEOUT_MS } from './aiTextConfig';
import type { AiTextConfig } from './aiTextConfig';
import type { GenerateOptions } from '../strategy/personaService';

/**
 * Default outbound request timeout (ms) for the text gateway. Kept safely UNDER
 * the nginx `proxy_read_timeout` for the API (30s/60s) so a slow/hanging gateway
 * is aborted by the app — and the caller can fall back to a deterministic
 * grounded answer — before the proxy returns a 504 to the user.
 *
 * @deprecated Prefer `AI_TEXT_DEFAULT_TIMEOUT_MS` from `./aiTextConfig`. Kept as a
 * re-export alias so any code that referenced `GEMINI_DEFAULT_TIMEOUT_MS` keeps
 * resolving.
 */
export const GEMINI_DEFAULT_TIMEOUT_MS = AI_TEXT_DEFAULT_TIMEOUT_MS;

/**
 * Hard ceiling (characters) on a streamed AI response we will accumulate. Mirror
 * of the buffered httpClient's 10MB byte cap (≈ a few MB of UTF-8 text): because
 * `streamContent` reads via fetch directly, this guards against a hostile or
 * runaway gateway streaming an unbounded body and exhausting process memory.
 */
export const AI_TEXT_MAX_STREAM_CHARS = 2_000_000;

/**
 * Extract the assistant message content from the OpenAI chat-completions shape.
 *
 * Pure & exported so it can be exhaustively property-tested (R7.1):
 *  - `content` is a string → return it as-is (R7.2).
 *  - `content` is an array of `{type,text}` parts → join the string `text`
 *    fields in order, skipping parts without a string `text`, with NO separator
 *    (R1.3, R7.7).
 *  - empty / no text / empty join result → `undefined` (R7.8 → caller throws
 *    `AI_BAD_RESPONSE`).
 */
export function extractText(body: unknown): string | undefined {
  // Primary: choices[0].message.content is a plain string.
  const content = readPath(body, 'choices.0.message.content');
  const asStr = asString(content);
  if (asStr !== undefined) return asStr;

  // Tolerant: some gateways return content as an array of {type,text} parts.
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (isRecord(part)) {
        const t = asString(part.text);
        if (t) texts.push(t);
      }
    }
    if (texts.length > 0) return texts.join('');
  }

  return undefined;
}

/**
 * Parse ONE SSE `data:` payload from the streaming chat-completions response.
 *
 * Pure & exported for property testing. The gateway emits OpenAI-style chunks:
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 * plus a terminal `data: [DONE]`. Reasoning models additionally emit
 * `delta.reasoning_content` (chain-of-thought) BEFORE the real answer — those
 * are intentionally IGNORED here so only user-facing `content` is surfaced.
 *
 * Returns:
 *  - `{ done: true }` for the `[DONE]` sentinel,
 *  - `{ done: false, content }` when a non-empty content delta is present,
 *  - `{ done: false }` for anything else (reasoning-only, empty, unparseable).
 */
export function extractStreamDelta(dataPayload: string): { done: boolean; content?: string } {
  const trimmed = dataPayload.trim();
  if (trimmed === '[DONE]') return { done: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { done: false };
  }
  const content = readPath(parsed, 'choices.0.delta.content');
  const asStr = asString(content);
  if (asStr !== undefined) return { done: false, content: asStr };
  return { done: false };
}

export class AiTextClient {
  private readonly http: HttpClient;

  /** Provider-neutral signature: normalized config + injected HTTP for tests. */
  constructor(
    private readonly apiKey: string | undefined,
    private readonly config: AiTextConfig,
    httpClient?: HttpClient,
    /**
     * Optional default `max_tokens` cap applied when a caller does NOT pass its
     * own `GenerateOptions.maxTokens`. Worst-case guard on generation length +
     * latency. `undefined` (the default) preserves the historic uncapped request
     * shape, so behaviour is unchanged unless an operator sets `GEMINI_MAX_TOKENS`.
     */
    private readonly defaultMaxTokens?: number,
  ) {
    // When no client is injected, build one that already enforces the timeout as
    // its default; an injected client (tests) is used as-is but still gets a
    // per-request `timeoutMs` below.
    this.http = httpClient ?? createFetchHttpClient(undefined, this.config.timeout);
  }

  /**
   * Resolve the effective `max_tokens` for a request: an explicit caller option
   * wins; otherwise the configured default cap (if any). Returns `undefined`
   * when neither is set, so `max_tokens` is omitted entirely (historic shape).
   */
  private effectiveMaxTokens(options?: GenerateOptions): number | undefined {
    const caller = options?.maxTokens;
    // A valid positive per-call value wins; otherwise fall back to the
    // configured default cap (also only when positive); else omit max_tokens.
    if (typeof caller === 'number' && caller > 0) return Math.floor(caller);
    return typeof this.defaultMaxTokens === 'number' && this.defaultMaxTokens > 0
      ? Math.floor(this.defaultMaxTokens)
      : undefined;
  }

  /** Generate text for a prompt. Throws 502 if the AI service is not configured. */
  async generateContent(prompt: string, options?: GenerateOptions): Promise<string> {
    // R2.4/R2.5: missing key OR missing/empty base URL → fail fast WITHOUT a
    // network call. (Base URL emptiness is already rejected by Config_Parser at
    // startup; this runtime guard is the second line of defense.)
    if (
      !this.apiKey ||
      this.apiKey.trim().length === 0 ||
      this.config.baseUrl.trim().length === 0
    ) {
      throw new AppError(502, 'AI not configured', 'AI_NOT_CONFIGURED');
    }

    // Base body is unchanged ({model, messages}); max_tokens/temperature are
    // ONLY added when supplied, so the historic request shape (and its tests)
    // hold when no options are passed. max_tokens caps worst-case generation
    // time for short formats; temperature is forwarded verbatim when set.
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
    };
    const effMax = this.effectiveMaxTokens(options);
    if (effMax !== undefined) {
      body.max_tokens = effMax;
    }
    if (typeof options?.temperature === 'number') {
      body.temperature = options.temperature;
    }

    let res;
    try {
      res = await this.http.post(
        `${this.config.baseUrl}/chat/completions`,
        body,
        { headers: { authorization: `Bearer ${this.apiKey}` }, timeoutMs: this.config.timeout },
      );
    } catch {
      // Covers network errors AND the abort-on-timeout: surface as a clean 502
      // so callers fall back to a deterministic grounded answer instead of
      // hanging the request.
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }
    if (!res.ok) {
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }

    const text = extractText(res.body);
    if (text === undefined) {
      throw new AppError(502, 'AI returned no content', 'AI_BAD_RESPONSE');
    }
    return text;
  }

  /**
   * Stream text for a prompt, invoking `onDelta` for each user-facing content
   * chunk as it arrives. Returns the FULL concatenated text once the stream
   * ends (so callers can persist exactly as the non-streaming path would).
   *
   * Uses `fetch` directly (the buffered HttpClient seam cannot stream) with the
   * same Bearer auth + abort-on-timeout. Reasoning-model `reasoning_content`
   * deltas are skipped by {@link extractStreamDelta}. Failure modes mirror
   * generateContent: 502 AI_NOT_CONFIGURED / AI_REQUEST_FAILED / AI_BAD_RESPONSE,
   * so the route can fall back to a deterministic answer.
   *
   * `fetchImpl` is injectable for tests; defaults to the global fetch.
   */
  async streamContent(
    prompt: string,
    onDelta: (chunk: string) => void,
    options?: GenerateOptions,
    fetchImpl: typeof fetch = fetch,
  ): Promise<string> {
    if (
      !this.apiKey ||
      this.apiKey.trim().length === 0 ||
      this.config.baseUrl.trim().length === 0
    ) {
      throw new AppError(502, 'AI not configured', 'AI_NOT_CONFIGURED');
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    };
    const effMax = this.effectiveMaxTokens(options);
    if (effMax !== undefined) {
      body.max_tokens = effMax;
    }
    if (typeof options?.temperature === 'number') {
      body.temperature = options.temperature;
    }

    const controller = new AbortController();
    const timer =
      this.config.timeout > 0 ? setTimeout(() => controller.abort(), this.config.timeout) : undefined;

    let res: Response;
    try {
      res = await fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (timer) clearTimeout(timer);
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }

    if (!res.ok || !res.body) {
      if (timer) clearTimeout(timer);
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }

    let full = '';
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        // Defense-in-depth: a hostile/misbehaving gateway could stream an
        // unbounded body. Because we use fetch directly (not the buffered
        // httpClient with its 10MB cap), enforce our own ceiling on BOTH the
        // accumulated answer and the unparsed line buffer, and abort if exceeded.
        if (full.length + buffer.length > AI_TEXT_MAX_STREAM_CHARS) {
          controller.abort();
          throw new AppError(502, 'AI response exceeds maximum size', 'AI_RESPONSE_TOO_LARGE');
        }
        // SSE frames are separated by a blank line; lines start with "data:".
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5);
          const delta = extractStreamDelta(payload);
          if (delta.done) {
            done = true;
            break;
          }
          if (delta.content) {
            full += delta.content;
            try {
              onDelta(delta.content);
            } catch {
              // A consumer callback error must not break the stream loop.
            }
          }
        }
      }
    } catch (err) {
      // Preserve our own typed errors (e.g. the size guard); wrap everything
      // else (network/parse/abort) as a clean 502 so callers can fall back.
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (full.trim().length === 0) {
      throw new AppError(502, 'AI returned no content', 'AI_BAD_RESPONSE');
    }
    return full;
  }
}

/** Backward-compatible alias for existing imports. */
export { AiTextClient as GeminiClient };
