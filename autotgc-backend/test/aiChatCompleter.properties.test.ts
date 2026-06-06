/**
 * Property-based tests for `AiTextChatCompleter` (src/infra/aiChatCompleter.ts) —
 * the real `ChatCompleter` over the OpenAI-compatible gateway (DeepSeek V4) that
 * activates the bounded agentic loop.
 *
 * Each test is tagged with its canonical property number/text
 * (`// Feature: agent-harness, Property {N}: {property_text}`) and runs >= 100
 * generated cases on fast-check. HTTP is injected via a small recording fake, so
 * no real network/provider is ever touched and the suite stays deterministic.
 *
 * NOTE: property tests explore the input space anew on each run, so they may
 * surface a previously-unseen edge case on any given run; a failure prints the
 * counterexample (and seed) for reproduction.
 *
 * Observed source behavior (verified against src/infra/aiTextClient.extractText
 * and src/platforms/narrow.asString): `asString` returns `undefined` for the
 * empty string, so a 2xx body whose only content is '' (and no tool_calls) is
 * treated as "no content" → AI_BAD_RESPONSE.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { AiTextChatCompleter, type ToolSchema } from '../src/infra/aiChatCompleter';
import type { AiTextConfig } from '../src/infra/aiTextConfig';
import { AppError } from '../src/infra/errors';
import type { ChatMessage } from '../src/infra/aiAgentLoop';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../src/platforms/httpClient';

// --- recording fake HttpClient ----------------------------------------------

interface RecordedCall {
  url: string;
  body: unknown;
  options?: HttpRequestOptions;
}

/** Fake HttpClient that records every call and returns a programmed response (or throws). */
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

// --- wire-shape response builders -------------------------------------------

/** OpenAI shape with only assistant text content. */
const textResponse = (content: unknown): HttpResponse => ({
  status: 200,
  ok: true,
  body: { choices: [{ message: { content } }] },
});

/** OpenAI shape with assistant tool_calls (and optionally text too). */
const toolCallsResponse = (
  toolCalls: Array<{ id: string; name: string; args: string }>,
  content?: unknown,
): HttpResponse => ({
  status: 200,
  ok: true,
  body: {
    choices: [
      {
        message: {
          ...(content === undefined ? {} : { content }),
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.args },
          })),
        },
      },
    ],
  },
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
  'https://gw.test/v1',
  'https://api.yescale.io/v1',
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

const roleArb: fc.Arbitrary<'system' | 'user' | 'assistant'> = fc.constantFrom(
  'system',
  'user',
  'assistant',
);

const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  role: roleArb,
  content: nonEmptyText,
});

const messagesArb: fc.Arbitrary<ChatMessage[]> = fc.array(chatMessageArb, {
  minLength: 1,
  maxLength: 5,
});

/** Two tool schemas; only 'knowledge_search' is ever allowed in tests below. */
const TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: 'knowledge_search',
    description: 'Search the knowledge base',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  {
    name: 'other',
    description: 'Some other tool',
    parameters: { type: 'object' },
  },
];

async function expectAppError(fn: () => Promise<unknown>, expectedCode: string): Promise<void> {
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

describe('agent-harness properties (AiTextChatCompleter.complete)', () => {
  // Feature: agent-harness, Property 1: Guard thiếu cấu hình — không gọi mạng
  // apiKey absent/empty/whitespace OR baseUrl empty/whitespace → complete()
  // throws AI_NOT_CONFIGURED (502) and HttpClient.post is NEVER called.
  it('Property 1: missing key OR blank baseUrl ⇒ AI_NOT_CONFIGURED, no network call', async () => {
    await fc.assert(
      fc.asyncProperty(
        // mode 'badKey' → blank/undefined key + valid config; 'badUrl' → real key + blank baseUrl.
        fc.constantFrom<'badKey' | 'badUrl'>('badKey', 'badUrl'),
        fc.oneof(fc.constant<string | undefined>(undefined), blankString),
        nonEmptyKey,
        validConfigArb,
        blankBaseUrlConfigArb,
        messagesArb,
        async (mode, badKey, goodKey, validConfig, blankUrlConfig, messages) => {
          const http = new RecordingHttpClient({
            kind: 'resolve',
            response: textResponse('x'),
          });
          const [key, config] =
            mode === 'badKey'
              ? [badKey, validConfig]
              : [goodKey, blankUrlConfig];
          const completer = new AiTextChatCompleter(key, config, TOOL_SCHEMAS, http);
          await expectAppError(() => completer.complete(messages, []), 'AI_NOT_CONFIGURED');
          expect(http.calls.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 2: Định dạng yêu cầu + dịch transcript tool→user + không lộ key
  // Configured ⇒ POST to `${baseUrl}/chat/completions`, body.model === config.model,
  // body.messages is the wire-message array, Authorization is `Bearer <key>`, the
  // key never appears in the serialized body, and a role:'tool' message is framed
  // as a role:'user' message whose content carries the tool name + content.
  it('Property 2: request shaping, Bearer auth, no key leak, tool→user framing', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyKey,
        validConfigArb,
        nonEmptyText, // user prompt
        nonEmptyText, // tool result content X
        async (key, config, prompt, toolContent) => {
          const http = new RecordingHttpClient({ kind: 'resolve', response: textResponse('ok') });
          const completer = new AiTextChatCompleter(key, config, [], http);

          const messages: ChatMessage[] = [
            { role: 'user', content: prompt },
            { role: 'tool', name: 'echo', content: toolContent, toolCallId: 'call_1' },
          ];
          await completer.complete(messages, []);

          expect(http.calls.length).toBe(1);
          const call = http.calls[0];
          expect(call.url).toBe(`${config.baseUrl}/chat/completions`);

          const body = call.body as {
            model: string;
            messages: Array<{ role: string; content: string }>;
          };
          expect(body.model).toBe(config.model);
          expect(Array.isArray(body.messages)).toBe(true);
          expect(body.messages.length).toBe(2);

          // Authorization header carries the Bearer key.
          expect(call.options?.headers?.authorization).toBe(`Bearer ${key}`);

          // The apiKey value must never appear in the serialized request body.
          expect(JSON.stringify(body).includes(key)).toBe(false);

          // role:'tool' → role:'user' framed message containing the tool name + content.
          const framed = body.messages[1];
          expect(framed.role).toBe('user');
          expect(framed.content.includes('echo')).toBe(true);
          expect(framed.content.includes(toolContent)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 3: Chỉ chào mời tool nằm trong allow-list
  // complete(messages, ['knowledge_search']) ⇒ body.tools contains ONLY the
  // knowledge_search function and tool_choice === 'auto'. complete(messages, [])
  // ⇒ body.tools is omitted (undefined) and no tool_choice is set.
  it('Property 3: tools offered only from allowed names; empty ⇒ tools omitted', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyKey, validConfigArb, messagesArb, async (key, config, messages) => {
        // (a) allow exactly knowledge_search.
        const httpAllowed = new RecordingHttpClient({ kind: 'resolve', response: textResponse('ok') });
        const allowedCompleter = new AiTextChatCompleter(key, config, TOOL_SCHEMAS, httpAllowed);
        await allowedCompleter.complete(messages, ['knowledge_search']);

        const allowedBody = httpAllowed.calls[0].body as {
          tools?: Array<{ type: string; function: { name: string } }>;
          tool_choice?: unknown;
        };
        expect(Array.isArray(allowedBody.tools)).toBe(true);
        expect(allowedBody.tools).toHaveLength(1);
        expect(allowedBody.tools![0].type).toBe('function');
        expect(allowedBody.tools![0].function.name).toBe('knowledge_search');
        expect(allowedBody.tools!.some((t) => t.function.name === 'other')).toBe(false);
        expect(allowedBody.tool_choice).toBe('auto');

        // (b) empty allow-list ⇒ tools omitted, no tool_choice.
        const httpNone = new RecordingHttpClient({ kind: 'resolve', response: textResponse('ok') });
        const noneCompleter = new AiTextChatCompleter(key, config, TOOL_SCHEMAS, httpNone);
        await noneCompleter.complete(messages, []);

        const noneBody = httpNone.calls[0].body as Record<string, unknown>;
        expect(noneBody.tools).toBeUndefined();
        expect('tool_choice' in noneBody).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 4: Phản hồi → ChatTurn (tool_calls ưu tiên hơn text)
  // 2xx body with assistant tool_calls ⇒ {kind:'tool_calls', toolCalls:[...]} (non-empty);
  // body with only text content ⇒ {kind:'text', content}; tool_calls win when both present.
  it('Property 4: response → ChatTurn (tool_calls > text)', async () => {
    const toolCallArb = fc.record({
      id: fc.constantFrom('call_1', 'call_2', 'abc'),
      name: fc.constantFrom('knowledge_search', 'other', 'echo'),
      args: fc.constantFrom('{}', '{"q":"hi"}', '{"a":1}'),
    });
    await fc.assert(
      fc.asyncProperty(
        nonEmptyKey,
        validConfigArb,
        messagesArb,
        fc.array(toolCallArb, { minLength: 1, maxLength: 3 }),
        nonEmptyText, // text content
        fc.constantFrom<'tool' | 'text' | 'both'>('tool', 'text', 'both'),
        async (key, config, messages, toolCalls, textContent, mode) => {
          let response: HttpResponse;
          if (mode === 'text') {
            response = textResponse(textContent);
          } else if (mode === 'tool') {
            response = toolCallsResponse(toolCalls);
          } else {
            response = toolCallsResponse(toolCalls, textContent);
          }
          const http = new RecordingHttpClient({ kind: 'resolve', response });
          const completer = new AiTextChatCompleter(key, config, TOOL_SCHEMAS, http);
          const turn = await completer.complete(messages, ['knowledge_search']);

          if (mode === 'text') {
            expect(turn.kind).toBe('text');
            if (turn.kind === 'text') expect(turn.content).toBe(textContent);
          } else {
            // tool & both ⇒ tool_calls take precedence.
            expect(turn.kind).toBe('tool_calls');
            if (turn.kind === 'tool_calls') {
              expect(turn.toolCalls.length).toBeGreaterThan(0);
              expect(turn.toolCalls.length).toBe(toolCalls.length);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 5: Ánh xạ lỗi — REQUEST_FAILED / BAD_RESPONSE, mọi lỗi 502
  // post throws OR resolves ok:false ⇒ AI_REQUEST_FAILED; 2xx body with neither
  // tool_calls nor extractable text ⇒ AI_BAD_RESPONSE. Every thrown error is 502.
  it('Property 5: failure mapping (REQUEST_FAILED / BAD_RESPONSE), all 502', async () => {
    const emptyContentArb = fc.oneof(
      fc.constant(''), // empty string → asString undefined → no text
      fc.constant(undefined), // missing content
      fc.constant([]), // empty parts array
      fc.array(fc.record({ type: fc.constant('image') }), { maxLength: 4 }), // parts w/o string text
      fc.array(fc.record({ text: fc.integer() }), { maxLength: 4 }), // text not a string
    );
    await fc.assert(
      fc.asyncProperty(
        nonEmptyKey,
        validConfigArb,
        messagesArb,
        fc.constantFrom<'throw' | 'notOk' | 'badBody'>('throw', 'notOk', 'badBody'),
        fc.integer({ min: 400, max: 599 }),
        emptyContentArb,
        async (key, config, messages, mode, status, emptyContent) => {
          let http: RecordingHttpClient;
          let expectedCode: string;
          if (mode === 'throw') {
            http = new RecordingHttpClient({ kind: 'throw', error: new Error('network down') });
            expectedCode = 'AI_REQUEST_FAILED';
          } else if (mode === 'notOk') {
            http = new RecordingHttpClient({ kind: 'resolve', response: { status, ok: false, body: {} } });
            expectedCode = 'AI_REQUEST_FAILED';
          } else {
            // 2xx but no tool_calls and no extractable text.
            http = new RecordingHttpClient({ kind: 'resolve', response: textResponse(emptyContent) });
            expectedCode = 'AI_BAD_RESPONSE';
          }
          const completer = new AiTextChatCompleter(key, config, TOOL_SCHEMAS, http);
          await expectAppError(() => completer.complete(messages, ['knowledge_search']), expectedCode);
        },
      ),
      { numRuns: 100 },
    );
  });
});
