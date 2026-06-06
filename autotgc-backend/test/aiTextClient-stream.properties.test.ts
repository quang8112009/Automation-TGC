/**
 * Tests for the SSE streaming support added to AiTextClient:
 *  - extractStreamDelta: pure parser for one `data:` payload.
 *  - streamContent: concatenates content deltas, skips reasoning_content,
 *    invokes onDelta per chunk, and returns the full text.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { AiTextClient, extractStreamDelta, AI_TEXT_MAX_STREAM_CHARS } from '../src/infra/aiTextClient';
import type { AiTextConfig } from '../src/infra/aiTextConfig';
import { AppError } from '../src/infra/errors';

const config: AiTextConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.yescale.io/v1',
  model: 'deepseek-v4-flash',
  timeout: 20_000,
};
const KEY = 'sk-stream-testkey-abcdefghij';

describe('extractStreamDelta (pure SSE chunk parser)', () => {
  it('returns done for the [DONE] sentinel', () => {
    expect(extractStreamDelta('[DONE]')).toEqual({ done: true });
    expect(extractStreamDelta(' [DONE] ')).toEqual({ done: true });
  });

  it('extracts a content delta', () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: 'Xin' } }] });
    expect(extractStreamDelta(payload)).toEqual({ done: false, content: 'Xin' });
  });

  it('ignores reasoning_content (chain-of-thought) deltas', () => {
    const payload = JSON.stringify({ choices: [{ delta: { reasoning_content: 'suy nghĩ' } }] });
    expect(extractStreamDelta(payload)).toEqual({ done: false });
  });

  it('returns not-done with no content for unparseable / empty / role-only frames', () => {
    expect(extractStreamDelta('not json')).toEqual({ done: false });
    expect(extractStreamDelta('{}')).toEqual({ done: false });
    expect(
      extractStreamDelta(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })),
    ).toEqual({ done: false });
  });

  it('treats an empty-string content as no content (asString rule)', () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: '' } }] });
    expect(extractStreamDelta(payload)).toEqual({ done: false });
  });
});

/** Build a fake fetch returning an SSE body from the given raw frames string. */
function sseFetch(frames: string, ok = true): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      },
    });
    return { ok, body: stream } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('AiTextClient.streamContent', () => {
  it('concatenates content deltas, skips reasoning, and reports each chunk', async () => {
    const frames =
      'data: {"choices":[{"delta":{"reasoning_content":"nghĩ"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Xin "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"chào"}}]}\n\n' +
      'data: [DONE]\n\n';
    const client = new AiTextClient(KEY, config);
    const chunks: string[] = [];
    const full = await client.streamContent('prompt', (c) => chunks.push(c), undefined, sseFetch(frames));
    expect(full).toBe('Xin chào');
    expect(chunks).toEqual(['Xin ', 'chào']);
  });

  it('throws AI_NOT_CONFIGURED without a key (no fetch call)', async () => {
    const client = new AiTextClient(undefined, config);
    let thrown: unknown;
    try {
      await client.streamContent('p', () => {}, undefined, sseFetch('', true));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('AI_NOT_CONFIGURED');
  });

  it('throws AI_REQUEST_FAILED on a non-ok response', async () => {
    const client = new AiTextClient(KEY, config);
    let thrown: unknown;
    try {
      await client.streamContent('p', () => {}, undefined, sseFetch('', false));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('AI_REQUEST_FAILED');
  });

  it('throws AI_BAD_RESPONSE when the stream yields no content', async () => {
    const frames = 'data: {"choices":[{"delta":{"reasoning_content":"chỉ suy nghĩ"}}]}\n\ndata: [DONE]\n\n';
    const client = new AiTextClient(KEY, config);
    let thrown: unknown;
    try {
      await client.streamContent('p', () => {}, undefined, sseFetch(frames));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('AI_BAD_RESPONSE');
  });

  it('property: full text equals concatenation of reported chunks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0), {
          minLength: 1,
          maxLength: 8,
        }),
        async (parts) => {
          const frames =
            parts
              .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
              .join('') + 'data: [DONE]\n\n';
          const client = new AiTextClient(KEY, config);
          const chunks: string[] = [];
          const full = await client.streamContent('p', (c) => chunks.push(c), undefined, sseFetch(frames));
          expect(chunks.join('')).toBe(full);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('aborts with AI_RESPONSE_TOO_LARGE when the stream exceeds the size cap', async () => {
    // One frame whose content alone exceeds the cap forces the guard to trip.
    const huge = 'x'.repeat(AI_TEXT_MAX_STREAM_CHARS + 10);
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: huge } }] })}\n\n`;
    const client = new AiTextClient(KEY, config);
    let thrown: unknown;
    try {
      await client.streamContent('p', () => {}, undefined, sseFetch(frames));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('AI_RESPONSE_TOO_LARGE');
    expect((thrown as AppError).status).toBe(502);
  });
});
