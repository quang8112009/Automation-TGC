/**
 * Property + unit tests for the pure SSE framing parser (`src/lib/sse.ts`) and
 * the assistant frame interpreter (`src/api/assistant.ts`). These underpin the
 * streaming chat client, so the invariants that matter are: never throw on
 * arbitrary bytes, correctly reassemble frames split across arbitrary chunk
 * boundaries, and tolerate malformed payloads (degrade, not crash).
 *
 * House style: property tests tagged `// Feature: assistant-stream, Property N`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseSseFrames, type SseFrame } from '../src/lib/sse';
import { interpretAssistantFrame } from '../src/api/assistant';

/** Serialize a frame the way the backend writes it: `event:`/`data:` + blank line. */
function writeFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/** Feed a full SSE text through the parser in fixed-size chunks (simulating the network). */
function parseChunked(text: string, chunkSize: number): SseFrame[] {
  const frames: SseFrame[] = [];
  let buffer = '';
  for (let i = 0; i < text.length; i += chunkSize) {
    buffer += text.slice(i, i + chunkSize);
    const res = parseSseFrames(buffer);
    frames.push(...res.frames);
    buffer = res.rest;
  }
  // Flush a final complete frame if the text ended exactly on a boundary.
  const tail = parseSseFrames(buffer);
  frames.push(...tail.frames);
  return frames;
}

describe('assistant-stream — parseSseFrames', () => {
  it('never throws on arbitrary input and leaves unterminated text in rest', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const res = parseSseFrames(s);
        expect(Array.isArray(res.frames)).toBe(true);
        expect(typeof res.rest).toBe('string');
      }),
      { numRuns: 200 },
    );
  });

  // Feature: assistant-stream, Property 1: a complete sequence of delta/done
  // frames is parsed back to the same (event, data) pairs regardless of the
  // network chunk size it is split into.
  it('Property 1: reassembles frames across arbitrary chunk boundaries', () => {
    const tokenArb = fc.string({ minLength: 1, maxLength: 12 }).map((s) => s.replace(/[\r\n]/g, ''));
    fc.assert(
      fc.property(fc.array(tokenArb, { minLength: 1, maxLength: 8 }), fc.integer({ min: 1, max: 7 }), (tokens, chunk) => {
        const deltas = tokens.map((t) => writeFrame('delta', JSON.stringify({ text: t }))).join('');
        const done = writeFrame('done', JSON.stringify({ aiGenerated: true, conversationId: 'c1' }));
        const text = `: connected\n\n${deltas}${done}`;

        const frames = parseChunked(text, chunk);
        const deltaTexts = frames
          .filter((f) => f.event === 'delta')
          .map((f) => (JSON.parse(f.data) as { text: string }).text);
        expect(deltaTexts).toEqual(tokens);
        const doneFrames = frames.filter((f) => f.event === 'done');
        expect(doneFrames).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it('drops heartbeat/comment-only blocks (no data line)', () => {
    const res = parseSseFrames(': connected\n\n: keepalive\n\n');
    expect(res.frames).toEqual([]);
    expect(res.rest).toBe('');
  });

  it('tolerates CRLF line endings', () => {
    const res = parseSseFrames('event: delta\r\ndata: {"text":"hi"}\r\n\r\n');
    expect(res.frames).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('keeps an unterminated trailing frame in rest until completed', () => {
    const first = parseSseFrames('event: delta\ndata: {"text":"par');
    expect(first.frames).toEqual([]);
    const second = parseSseFrames(`${first.rest}tial"}\n\n`);
    expect(second.frames).toEqual([{ event: 'delta', data: '{"text":"partial"}' }]);
  });
});

describe('assistant-stream — interpretAssistantFrame', () => {
  // Feature: assistant-stream, Property 2: a well-formed delta frame yields the
  // exact text; a malformed delta yields null (ignored, never throws).
  it('Property 2: delta frames map to their text; malformed → null', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const ev = interpretAssistantFrame({ event: 'delta', data: JSON.stringify({ text }) });
        expect(ev).toEqual({ type: 'delta', text });
      }),
      { numRuns: 100 },
    );
    expect(interpretAssistantFrame({ event: 'delta', data: 'not json' })).toBeNull();
    expect(interpretAssistantFrame({ event: 'delta', data: '{"text":123}' })).toBeNull();
    expect(interpretAssistantFrame({ event: 'message', data: 'whatever' })).toBeNull();
  });

  it('done frames carry aiGenerated; malformed done degrades to non-AI', () => {
    expect(interpretAssistantFrame({ event: 'done', data: '{"aiGenerated":true,"conversationId":"c1"}' })).toEqual({
      type: 'done',
      done: { aiGenerated: true, conversationId: 'c1' },
    });
    expect(interpretAssistantFrame({ event: 'done', data: '{"aiGenerated":false,"conversationId":null}' })).toEqual({
      type: 'done',
      done: { aiGenerated: false, conversationId: null },
    });
    // Malformed → safe non-AI completion, never throws.
    expect(interpretAssistantFrame({ event: 'done', data: 'garbage' })).toEqual({
      type: 'done',
      done: { aiGenerated: false, conversationId: null },
    });
  });
});
