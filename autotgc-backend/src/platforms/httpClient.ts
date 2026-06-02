/**
 * Minimal HTTP client seam used by the platform adapters and Gemini client.
 * Keeping HTTP behind a tiny injected interface keeps adapters unit-testable
 * (mock the client) and free of any hardcoded transport details.
 */

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  /** Query string params appended to the URL for GET requests. */
  query?: Record<string, string | number | undefined>;
  /**
   * Per-request timeout in milliseconds. When set (and > 0) the request is
   * aborted via an AbortController after this many ms, so a slow/hanging
   * upstream surfaces as a rejected promise instead of blocking forever.
   * Overrides any factory-level default. Omitted/<=0 means "no timeout".
   */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface HttpClient {
  post(url: string, body: unknown, options?: HttpRequestOptions): Promise<HttpResponse>;
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

/**
 * Default outbound request timeout (ms) for the platform adapters (Facebook,
 * TikTok, GA4, YouTube, Zalo, Custom CMS). Without it a slow/hanging upstream
 * would block a publish/analytics call indefinitely and tie up a worker. Kept
 * generous (30s) because some platform endpoints (uploads, report runs) are
 * legitimately slow; the per-request `timeoutMs` can still override it.
 */
export const PLATFORM_DEFAULT_TIMEOUT_MS = 30_000;

function buildUrl(url: string, query?: HttpRequestOptions['query']): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  if (!qs) return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

/** Hard ceiling on an upstream response body we will buffer (10 MB). A hostile
 * or misbehaving gateway returning an unbounded stream must not be able to
 * exhaust process memory. Bodies past this are rejected rather than buffered. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

async function parseBody(res: Response): Promise<unknown> {
  // Fast-path rejection when the upstream advertises an oversized body.
  const declaredLength = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Upstream response exceeds maximum allowed size');
  }
  const text = await res.text();
  // Defense-in-depth: enforce the cap on the actual payload too (content-length
  // can be absent or untrustworthy, e.g. chunked transfer encoding).
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Upstream response exceeds maximum allowed size');
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Run a fetch with an optional abort-on-timeout. When `timeoutMs > 0` an
 * AbortController fires after the deadline so a slow/hanging upstream rejects
 * (the caller can then fall back) instead of blocking forever. When no timeout
 * is set the call behaves exactly as a plain `fetch`. The timer is always
 * cleared in `finally` so it never leaks or keeps the event loop alive.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default HttpClient backed by the global `fetch` (Node 20+). No URLs or
 * credentials are baked in here — callers pass fully-formed URLs and headers.
 *
 * `defaultTimeoutMs` applies a request deadline to every call that does not
 * pass its own `timeoutMs` (a per-request `timeoutMs` always wins). This keeps
 * outbound calls to flaky gateways (e.g. the AI text gateway) from hanging the
 * request indefinitely. Pass `0`/omit for the historic no-timeout behavior.
 */
export function createFetchHttpClient(
  fetchImpl: typeof fetch = fetch,
  defaultTimeoutMs?: number,
): HttpClient {
  const resolveTimeout = (options?: HttpRequestOptions): number | undefined =>
    options?.timeoutMs !== undefined ? options.timeoutMs : defaultTimeoutMs;

  return {
    async post(url, body, options) {
      const res = await fetchWithTimeout(
        fetchImpl,
        buildUrl(url, options?.query),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options?.headers ?? {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        resolveTimeout(options),
      );
      return { status: res.status, ok: res.ok, body: await parseBody(res) };
    },
    async get(url, options) {
      const res = await fetchWithTimeout(
        fetchImpl,
        buildUrl(url, options?.query),
        {
          method: 'GET',
          headers: { ...(options?.headers ?? {}) },
        },
        resolveTimeout(options),
      );
      return { status: res.status, ok: res.ok, body: await parseBody(res) };
    },
  };
}
