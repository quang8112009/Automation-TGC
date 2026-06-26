/**
 * Tests for the env-configurable DEFAULT max_tokens cap on AiTextClient.
 *
 * Goal: cap worst-case generation length/latency WITHOUT changing behaviour
 * unless an operator opts in via GEMINI_MAX_TOKENS. Invariants:
 *  - No default + no caller option  -> request omits max_tokens (historic shape).
 *  - Default set, caller omits       -> request carries the default cap.
 *  - Caller passes maxTokens         -> caller value WINS over the default.
 *  - parseMaxTokensEnv               -> positive int or undefined (floors; rejects 0/neg/blank/NaN).
 */
import { describe, it, expect } from 'vitest';
import { AiTextClient } from '../src/infra/aiTextClient';
import { parseMaxTokensEnv } from '../src/infra/aiTextConfig';
import type { AiTextConfig } from '../src/infra/aiTextConfig';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../src/platforms/httpClient';

const CONFIG: AiTextConfig = {
  provider: 'deepseek',
  baseUrl: 'https://gateway.example/v1',
  model: 'deepseek-v4-flash',
  timeout: 20_000,
};

class RecordingHttpClient implements HttpClient {
  lastBody: unknown;
  async post(_url: string, body: unknown, _o?: HttpRequestOptions): Promise<HttpResponse> {
    this.lastBody = body;
    return { status: 200, ok: true, body: { choices: [{ message: { content: 'ok' } }] } };
  }
  async get(_url: string, _o?: HttpRequestOptions): Promise<HttpResponse> {
    return { status: 200, ok: true, body: {} };
  }
}

function bodyOf(http: RecordingHttpClient): { max_tokens?: number } {
  return http.lastBody as { max_tokens?: number };
}

describe('AiTextClient default max_tokens cap', () => {
  it('omits max_tokens when neither a default nor a caller option is set (historic shape)', async () => {
    const http = new RecordingHttpClient();
    const client = new AiTextClient('sk-key', CONFIG, http); // no defaultMaxTokens
    await client.generateContent('hello');
    expect('max_tokens' in bodyOf(http)).toBe(false);
  });

  it('applies the configured default when the caller omits maxTokens', async () => {
    const http = new RecordingHttpClient();
    const client = new AiTextClient('sk-key', CONFIG, http, 512);
    await client.generateContent('hello');
    expect(bodyOf(http).max_tokens).toBe(512);
  });

  it('lets an explicit caller maxTokens WIN over the default', async () => {
    const http = new RecordingHttpClient();
    const client = new AiTextClient('sk-key', CONFIG, http, 512);
    await client.generateContent('hello', { maxTokens: 120 });
    expect(bodyOf(http).max_tokens).toBe(120);
  });

  it('floors a fractional default and ignores non-positive caller values', async () => {
    const http = new RecordingHttpClient();
    const client = new AiTextClient('sk-key', CONFIG, http, 100.9);
    // caller passes 0 (non-positive) -> falls back to the default 100 (floored)
    await client.generateContent('hello', { maxTokens: 0 });
    expect(bodyOf(http).max_tokens).toBe(100);
  });
});

describe('parseMaxTokensEnv', () => {
  it('parses positive integers and numeric strings', () => {
    expect(parseMaxTokensEnv('512')).toBe(512);
    expect(parseMaxTokensEnv(1024)).toBe(1024);
    expect(parseMaxTokensEnv('100.9')).toBe(100); // floored
  });

  it('returns undefined for blank/invalid/non-positive (no cap = historic behaviour)', () => {
    expect(parseMaxTokensEnv(undefined)).toBeUndefined();
    expect(parseMaxTokensEnv('')).toBeUndefined();
    expect(parseMaxTokensEnv('  ')).toBeUndefined();
    expect(parseMaxTokensEnv('abc')).toBeUndefined();
    expect(parseMaxTokensEnv('0')).toBeUndefined();
    expect(parseMaxTokensEnv('-5')).toBeUndefined();
    expect(parseMaxTokensEnv(Number.NaN)).toBeUndefined();
    expect(parseMaxTokensEnv(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
