/**
 * Tests for the AI-OPTIONAL embedding client (`src/infra/embeddingClient.ts`):
 *  - `extractEmbedding` tolerantly parses the OpenAI embeddings response shape.
 *  - `AiEmbeddingClient.embed` NEVER throws and returns `undefined` whenever the
 *    provider is unconfigured / errors / returns garbage — the AI-OPTIONAL
 *    guarantee that lets grounding retrieval degrade to keyword ranking.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { extractEmbedding, AiEmbeddingClient } from '../src/infra/embeddingClient';
import type { HttpClient, HttpResponse } from '../src/platforms/httpClient';

/** HttpClient double returning a scripted response (or throwing). */
function fakeHttp(impl: () => HttpResponse | Promise<HttpResponse>): HttpClient {
  return {
    post: async () => impl(),
    get: async () => impl(),
  } as unknown as HttpClient;
}

const okBody = (embedding: number[]): unknown => ({ data: [{ embedding }] });

describe('semantic-retrieval — extractEmbedding', () => {
  it('Property 1: extracts data[0].embedding of finite numbers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 8 }),
        (vec) => {
          expect(extractEmbedding(okBody(vec))).toEqual(vec);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns undefined for malformed shapes', () => {
    expect(extractEmbedding(null)).toBeUndefined();
    expect(extractEmbedding({})).toBeUndefined();
    expect(extractEmbedding({ data: [] })).toBeUndefined();
    expect(extractEmbedding({ data: [{}] })).toBeUndefined();
    expect(extractEmbedding({ data: [{ embedding: [] }] })).toBeUndefined();
    expect(extractEmbedding({ data: [{ embedding: [1, 'x'] }] })).toBeUndefined();
  });
});

describe('semantic-retrieval — AiEmbeddingClient.embed (AI-OPTIONAL)', () => {
  const cfg = { baseUrl: 'https://gw.example/v1', model: 'embed-1', timeout: 1000 };

  it('returns undefined when no API key is configured (no network call)', async () => {
    let called = false;
    const http = fakeHttp(() => {
      called = true;
      return { ok: true, status: 200, body: okBody([1, 2]) } as HttpResponse;
    });
    const client = new AiEmbeddingClient(undefined, cfg.baseUrl, cfg.model, cfg.timeout, http);
    expect(await client.embed('hello')).toBeUndefined();
    expect(called).toBe(false);
  });

  it('returns undefined for blank input (no network call)', async () => {
    let called = false;
    const http = fakeHttp(() => {
      called = true;
      return { ok: true, status: 200, body: okBody([1, 2]) } as HttpResponse;
    });
    const client = new AiEmbeddingClient('key', cfg.baseUrl, cfg.model, cfg.timeout, http);
    expect(await client.embed('   ')).toBeUndefined();
    expect(called).toBe(false);
  });

  it('returns the vector on a successful response', async () => {
    const http = fakeHttp(() => ({ ok: true, status: 200, body: okBody([0.1, 0.2, 0.3]) } as HttpResponse));
    const client = new AiEmbeddingClient('key', cfg.baseUrl, cfg.model, cfg.timeout, http);
    expect(await client.embed('hello')).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns undefined (never throws) when the HTTP call rejects', async () => {
    const http = fakeHttp(() => {
      throw new Error('network down');
    });
    const client = new AiEmbeddingClient('key', cfg.baseUrl, cfg.model, cfg.timeout, http);
    await expect(client.embed('hello')).resolves.toBeUndefined();
  });

  it('returns undefined on a non-ok response', async () => {
    const http = fakeHttp(() => ({ ok: false, status: 502, body: {} } as HttpResponse));
    const client = new AiEmbeddingClient('key', cfg.baseUrl, cfg.model, cfg.timeout, http);
    expect(await client.embed('hello')).toBeUndefined();
  });
});
