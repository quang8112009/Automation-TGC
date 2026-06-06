/**
 * Property-based tests for the deepseek-v4-model-migration spec — the
 * `AiTextClient.generateContent` request/response behavior over an injected
 * (fake) HttpClient.
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: deepseek-v4-model-migration, Property {N}: {property_text}`) and
 * runs >= 100 generated cases on fast-check (R7.1). HTTP is injected via a tiny
 * recording fake, so no real network is touched.
 *
 * Observed source behavior (verified against src/platforms/narrow.ts):
 * `asString` returns `undefined` for the empty string, so `extractText` treats
 * empty-string content as "no content" → `generateContent` throws
 * `AI_BAD_RESPONSE`. The AI_BAD_RESPONSE cases below rely on that.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { AiTextClient } from '../src/infra/aiTextClient';
import type { AiTextConfig } from '../src/infra/aiTextConfig';
import { AppError } from '../src/infra/errors';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../src/platforms/httpClient';

// --- recording fake HttpClient ----------------------------------------------

interface RecordedCall {
  url: string;
  body: unknown;
  options?: HttpRequestOptions;
}

/** Fake HttpClient that records every call and returns a programmed response. */
class RecordingHttpClient implements HttpClient {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly behavior:
      | { kind: 'resolve'; response: HttpResponse }
      | { kind: 'throw'; error: Error },
  ) {}

  async post(url: string, body: unknown, options?: HttpRequestOptions): Promise<HttpResponse> {
    this.calls.push({ url, body, options });
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    return this.behavior.response;
  }

  async get(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    this.calls.push({ url, options, body: undefined });
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    return this.behavior.response;
  }
}

const okResponse = (content: unknown): HttpResponse => ({
  status: 200,
  ok: true,
  body: { choices: [{ message: { content } }] },
});

// --- generators --------------------------------------------------------------

const nonEmptyKey: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
    ),
    { minLength: 12, maxLength: 48 },
  )
  .map((cs) => `sk-${cs.join('')}`);

/** Blank-ish strings (empty / whitespace-only). */
const blankString: fc.Arbitrary<string> = fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), {
  minLength: 0,
  maxLength: 5,
});

const nonEmptyText: fc.Arbitrary<string> = fc
  .fullUnicodeString({ minLength: 1, maxLength: 40 })
  .filter((s) => s.length > 0);

const baseUrlArb: fc.Arbitrary<string> = fc.constantFrom(
  'https://api.yescale.io/v1',
  'https://gateway.example/v1',
  'http://localhost:8080/v1',
);

const modelArb: fc.Arbitrary<string> = fc.constantFrom(
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'some-other-model',
);

const validConfigArb: fc.Arbitrary<AiTextConfig> = fc.record({
  provider: fc.constant('deepseek'),
  baseUrl: baseUrlArb,
  model: modelArb,
  timeout: fc.integer({ min: 100, max: 60_000 }),
});

/** A config whose baseUrl is blank (empty/whitespace) — must be treated as unconfigured. */
const blankBaseUrlConfigArb: fc.Arbitrary<AiTextConfig> = fc.record({
  provider: fc.constant('deepseek'),
  baseUrl: blankString,
  model: modelArb,
  timeout: fc.integer({ min: 100, max: 60_000 }),
});

async function expectAppError(
  fn: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(AppError);
  const err = thrown as AppError;
  expect(err.code).toBe(expectedCode);
  expect(err.status).toBe(502);
}

// --- tests -------------------------------------------------------------------

describe('deepseek-v4-model-migration properties (AiTextClient.generateContent)', async () => {
  // Feature: deepseek-v4-model-migration, Property 4: Guard thiếu cấu hình kết nối
  // apiKey absent/empty/whitespace OR baseUrl empty/whitespace → throws
  // AI_NOT_CONFIGURED and never calls the HttpClient; both present → posts once
  // to `${baseUrl}/chat/completions`.
  // Validates: Requirements 2.4, 2.5, 2.8
  it('Property 4: missing key/baseUrl ⇒ AI_NOT_CONFIGURED, no network call', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(undefined), blankString),
        validConfigArb,
        nonEmptyText,
        async (badKey, config, prompt) => {
          const http = new RecordingHttpClient({ kind: 'resolve', response: okResponse('x') });
          const client = new AiTextClient(badKey, config, http);
          await expectAppError(() => client.generateContent(prompt), 'AI_NOT_CONFIGURED');
          expect(http.calls.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 4: blank baseUrl ⇒ AI_NOT_CONFIGURED, no network call', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyKey, blankBaseUrlConfigArb, nonEmptyText, async (key, config, prompt) => {
        const http = new RecordingHttpClient({ kind: 'resolve', response: okResponse('x') });
        const client = new AiTextClient(key, config, http);
        await expectAppError(() => client.generateContent(prompt), 'AI_NOT_CONFIGURED');
        expect(http.calls.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 4: configured ⇒ posts exactly once to {baseUrl}/chat/completions', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyKey, validConfigArb, nonEmptyText, async (key, config, prompt) => {
        const http = new RecordingHttpClient({ kind: 'resolve', response: okResponse('ok') });
        const client = new AiTextClient(key, config, http);
        const out = await client.generateContent(prompt);
        expect(out).toBe('ok');
        expect(http.calls.length).toBe(1);
        expect(http.calls[0].url).toBe(`${config.baseUrl}/chat/completions`);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 13: Thân yêu cầu mang model + messages không rỗng + prompt
  // Validates: Requirements 1.1
  it('Property 13: request body carries model, non-empty messages with the prompt, and Bearer auth', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyKey, validConfigArb, nonEmptyText, async (key, config, prompt) => {
        const http = new RecordingHttpClient({ kind: 'resolve', response: okResponse('ok') });
        const client = new AiTextClient(key, config, http);
        await client.generateContent(prompt);

        const call = http.calls[0];
        const body = call.body as { model: string; messages: Array<{ role: string; content: string }> };
        expect(body.model).toBe(config.model);
        expect(Array.isArray(body.messages)).toBe(true);
        expect(body.messages.length).toBeGreaterThan(0);
        expect(body.messages.some((m) => m.content === prompt)).toBe(true);
        expect(call.options?.headers?.authorization).toBe(`Bearer ${key}`);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 7: Không lộ bí mật trong đầu ra
  // (part (b)) The serialized request body/messages never contains the apiKey value.
  // Validates: Requirements 2.7
  it('Property 7(b): the posted request body never contains the apiKey value', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyKey, validConfigArb, nonEmptyText, async (key, config, prompt) => {
        const http = new RecordingHttpClient({ kind: 'resolve', response: okResponse('ok') });
        const client = new AiTextClient(key, config, http);
        await client.generateContent(prompt);
        const serializedBody = JSON.stringify(http.calls[0].body);
        expect(serializedBody.includes(key)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 5: Phản hồi không có nội dung văn bản báo lỗi AI_BAD_RESPONSE
  // Validates: Requirements 3.7, 7.8
  it('Property 5: 2xx with no extractable text ⇒ AI_BAD_RESPONSE', async () => {
    const emptyContentArb = fc.oneof(
      fc.constant(''), // empty string → asString undefined → extractText undefined
      fc.constant(undefined), // missing content
      fc.constant([]), // empty parts array
      fc.array(fc.record({ type: fc.constant('image') }), { maxLength: 4 }), // parts w/o string text
      fc.array(fc.record({ text: fc.integer() }), { maxLength: 4 }), // text not a string
    );
    await fc.assert(
      fc.asyncProperty(nonEmptyKey, validConfigArb, nonEmptyText, emptyContentArb, async (key, config, prompt, content) => {
        const http = new RecordingHttpClient({ kind: 'resolve', response: okResponse(content) });
        const client = new AiTextClient(key, config, http);
        await expectAppError(() => client.generateContent(prompt), 'AI_BAD_RESPONSE');
      }),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 6: Lỗi mạng/timeout/không-ok báo lỗi AI_REQUEST_FAILED
  // Validates: Requirements 3.6
  it('Property 6: post throws OR resolves not-ok ⇒ AI_REQUEST_FAILED', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyKey,
        validConfigArb,
        nonEmptyText,
        fc.boolean(),
        fc.integer({ min: 400, max: 599 }),
        async (key, config, prompt, asThrow, status) => {
          const http = asThrow
            ? new RecordingHttpClient({ kind: 'throw', error: new Error('network down') })
            : new RecordingHttpClient({ kind: 'resolve', response: { status, ok: false, body: {} } });
          const client = new AiTextClient(key, config, http);
          await expectAppError(() => client.generateContent(prompt), 'AI_REQUEST_FAILED');
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 15: Mã trạng thái HTTP thuộc tập cho phép
  // Every AppError thrown by the client has status === 502 (in the allowed set).
  // Validates: Requirements 7.3
  it('Property 15: every client error has AppError.status === 502', async () => {
    const failureArb = fc.oneof(
      fc.constant<'noKey' | 'throw' | 'notOk' | 'badBody'>('noKey'),
      fc.constant('throw'),
      fc.constant('notOk'),
      fc.constant('badBody'),
    );
    await fc.assert(
      fc.asyncProperty(nonEmptyKey, validConfigArb, nonEmptyText, failureArb, async (key, config, prompt, mode) => {
        let http: RecordingHttpClient;
        let apiKey: string | undefined = key;
        switch (mode) {
          case 'noKey':
            apiKey = undefined;
            http = new RecordingHttpClient({ kind: 'resolve', response: okResponse('x') });
            break;
          case 'throw':
            http = new RecordingHttpClient({ kind: 'throw', error: new Error('boom') });
            break;
          case 'notOk':
            http = new RecordingHttpClient({ kind: 'resolve', response: { status: 500, ok: false, body: {} } });
            break;
          default:
            http = new RecordingHttpClient({ kind: 'resolve', response: okResponse('') });
            break;
        }
        const client = new AiTextClient(apiKey, config, http);
        let thrown: unknown;
        try {
          await client.generateContent(prompt);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(AppError);
        expect((thrown as AppError).status).toBe(502);
      }),
      { numRuns: 100 },
    );
  });
});
