/**
 * Property tests for the optional generation tuning (max_tokens / temperature)
 * added to AiTextClient.generateContent.
 *
 * Invariants:
 *  - With NO options, the request body is exactly {model, messages} — byte-for-
 *    byte the historic shape (no max_tokens/temperature keys leak in).
 *  - With maxTokens > 0, body.max_tokens is the floored integer.
 *  - With a temperature, body.temperature is forwarded verbatim.
 *  - The prompt + Bearer auth behavior is unchanged.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { AiTextClient } from '../src/infra/aiTextClient';
import type { AiTextConfig } from '../src/infra/aiTextConfig';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../src/platforms/httpClient';

interface RecordedCall {
  url: string;
  body: unknown;
  options?: HttpRequestOptions;
}

class RecordingHttpClient implements HttpClient {
  readonly calls: RecordedCall[] = [];
  async post(url: string, body: unknown, options?: HttpRequestOptions): Promise<HttpResponse> {
    this.calls.push({ url, body, options });
    return { status: 200, ok: true, body: { choices: [{ message: { content: 'ok' } }] } };
  }
  async get(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    this.calls.push({ url, options, body: undefined });
    return { status: 200, ok: true, body: { choices: [{ message: { content: 'ok' } }] } };
  }
}

const config: AiTextConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.yescale.io/v1',
  model: 'deepseek-v4-flash',
  timeout: 20_000,
};

const KEY = 'sk-testkey-abcdefghijklmnop';
const prompt = 'Viet noi dung thu nghiem';

describe('AiTextClient generation options (max_tokens / temperature)', () => {
  it('omits max_tokens/temperature entirely when no options are passed', async () => {
    const http = new RecordingHttpClient();
    const client = new AiTextClient(KEY, config, http);
    await client.generateContent(prompt);
    const body = http.calls[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['messages', 'model']);
    expect('max_tokens' in body).toBe(false);
    expect('temperature' in body).toBe(false);
  });

  it('floors and forwards a positive maxTokens', async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 1, max: 8000, noNaN: true }), async (mt) => {
        const http = new RecordingHttpClient();
        const client = new AiTextClient(KEY, config, http);
        await client.generateContent(prompt, { maxTokens: mt });
        const body = http.calls[0].body as Record<string, unknown>;
        expect(body.max_tokens).toBe(Math.floor(mt));
      }),
      { numRuns: 100 },
    );
  });

  it('does not add max_tokens for non-positive values', async () => {
    for (const mt of [0, -5, -0.4]) {
      const http = new RecordingHttpClient();
      const client = new AiTextClient(KEY, config, http);
      await client.generateContent(prompt, { maxTokens: mt });
      const body = http.calls[0].body as Record<string, unknown>;
      expect('max_tokens' in body).toBe(false);
    }
  });

  it('forwards temperature verbatim when provided', async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 0, max: 2, noNaN: true }), async (t) => {
        const http = new RecordingHttpClient();
        const client = new AiTextClient(KEY, config, http);
        await client.generateContent(prompt, { temperature: t });
        const body = http.calls[0].body as Record<string, unknown>;
        expect(body.temperature).toBe(t);
      }),
      { numRuns: 50 },
    );
  });

  it('never leaks the api key into the body even with options', async () => {
    const http = new RecordingHttpClient();
    const client = new AiTextClient(KEY, config, http);
    await client.generateContent(prompt, { maxTokens: 500, temperature: 0.7 });
    expect(JSON.stringify(http.calls[0].body).includes(KEY)).toBe(false);
    expect(http.calls[0].options?.headers?.authorization).toBe(`Bearer ${KEY}`);
  });
});
