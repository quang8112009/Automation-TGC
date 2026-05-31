/**
 * Minimal HTTP client seam used by the platform adapters and Gemini client.
 * Keeping HTTP behind a tiny injected interface keeps adapters unit-testable
 * (mock the client) and free of any hardcoded transport details.
 */

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  /** Query string params appended to the URL for GET requests. */
  query?: Record<string, string | number | undefined>;
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

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Default HttpClient backed by the global `fetch` (Node 20+). No URLs or
 * credentials are baked in here — callers pass fully-formed URLs and headers.
 */
export function createFetchHttpClient(fetchImpl: typeof fetch = fetch): HttpClient {
  return {
    async post(url, body, options) {
      const res = await fetchImpl(buildUrl(url, options?.query), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options?.headers ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, ok: res.ok, body: await parseBody(res) };
    },
    async get(url, options) {
      const res = await fetchImpl(buildUrl(url, options?.query), {
        method: 'GET',
        headers: { ...(options?.headers ?? {}) },
      });
      return { status: res.status, ok: res.ok, body: await parseBody(res) };
    },
  };
}
