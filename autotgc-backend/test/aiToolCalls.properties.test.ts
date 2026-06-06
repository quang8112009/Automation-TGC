/**
 * Property-based tests for the Tool-call layer (`src/infra/aiToolCalls.ts`),
 * the agent-harness Tool layer. Covers governed parsing + dispatch of
 * OpenAI/DeepSeek `tool_calls` so the model can request tools WITHOUT the system
 * ever executing something it did not explicitly allow.
 *
 * House style: each test tagged `// Feature: agent-harness, Property {N}: {text}`;
 * async properties use `fc.asyncProperty` + `await fc.assert`; `{ numRuns: 100 }`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  parseToolCalls,
  dispatchToolCall,
  dispatchToolCalls,
  ToolRegistry,
  type ToolCall,
} from '../src/infra/aiToolCalls';

// --- helpers -----------------------------------------------------------------

/** Build a chat-completions body whose assistant message carries tool_calls. */
function bodyWithToolCalls(toolCalls: unknown): unknown {
  return { choices: [{ message: { tool_calls: toolCalls } }] };
}

/** A well-formed provider tool_call entry. */
function rawCall(id: string, name: string, args: unknown): unknown {
  return { id, type: 'function', function: { name, arguments: args } };
}

// --- generators --------------------------------------------------------------

const nameArb = fc.constantFrom('search', 'lookup', 'getWeather', 'calc', 'fetchLead');
const idArb = fc.string({ minLength: 1, maxLength: 12 });
const argObjArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { maxKeys: 4 },
);

// =============================================================================
// Property 1 — parseToolCalls extracts well-formed calls
// =============================================================================
describe('agent-harness — parseToolCalls (Property 1)', () => {
  // Feature: agent-harness, Property 1: For any list of well-formed tool_call entries (string id,
  // function.name non-empty, arguments an object OR a JSON-object string), parseToolCalls returns
  // one ToolCall per entry in order, with arguments coerced to an object.
  it('Property 1: well-formed entries → one parsed ToolCall each, in order, args as object', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(idArb, nameArb, argObjArb, fc.boolean()), { minLength: 1, maxLength: 6 }),
        (entries) => {
          const raw = entries.map(([id, name, args, asJsonString]) =>
            rawCall(id, name, asJsonString ? JSON.stringify(args) : args),
          );
          const parsed = parseToolCalls(bodyWithToolCalls(raw));
          expect(parsed.length).toBe(entries.length);
          parsed.forEach((call, i) => {
            const [id, name, args] = entries[i];
            expect(call.id).toBe(id);
            expect(call.name).toBe(name);
            expect(typeof call.arguments).toBe('object');
            expect(call.arguments).toEqual(args);
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 2: Malformed input never throws and never yields a call that
  // cannot be safely dispatched — missing message/tool_calls → []; entries without a string
  // function.name, or with unparseable (non-object JSON string) arguments, are skipped.
  it('Property 2: malformed bodies/entries are tolerated (skip or []), never throw', () => {
    const malformedBody = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant({}),
      fc.constant({ choices: [] }),
      fc.constant({ choices: [{}] }),
      fc.constant(bodyWithToolCalls('not-an-array')),
      fc.constant(bodyWithToolCalls([null, 42, 'x'])),
      fc.constant(bodyWithToolCalls([{ function: {} }])), // missing name
      fc.constant(bodyWithToolCalls([rawCall('1', 'search', '<<<not json>>>')])), // bad JSON string
      fc.constant(bodyWithToolCalls([rawCall('1', 'search', '[1,2,3]')])), // JSON but not an object
      fc.constant(bodyWithToolCalls([{ id: '1', function: { name: '' } }])), // empty name
    );
    fc.assert(
      fc.property(malformedBody, (body) => {
        const parsed = parseToolCalls(body);
        expect(Array.isArray(parsed)).toBe(true);
        // Any returned call must be dispatchable-shaped: non-empty name + object args.
        for (const c of parsed) {
          expect(typeof c.name).toBe('string');
          expect(c.name.length).toBeGreaterThan(0);
          expect(typeof c.arguments).toBe('object');
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 3: Absent/empty arguments coerce to an empty object {} so a
  // no-arg tool call is still dispatchable.
  it('Property 3: absent/empty arguments → empty object', () => {
    fc.assert(
      fc.property(idArb, nameArb, fc.constantFrom(undefined, null, '', '   '), (id, name, args) => {
        const parsed = parseToolCalls(bodyWithToolCalls([rawCall(id, name, args)]));
        expect(parsed.length).toBe(1);
        expect(parsed[0].arguments).toEqual({});
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 4 — governed dispatch (allow-list)
// =============================================================================
describe('agent-harness — dispatchToolCall governance (Property 4)', () => {
  // Feature: agent-harness, Property 4: A call to a tool NOT in the registry is always rejected with
  // TOOL_NOT_ALLOWED and the handler is never invoked (no arbitrary execution).
  it('Property 4: unregistered tool → TOOL_NOT_ALLOWED, never executes', async () => {
    await fc.assert(
      fc.asyncProperty(idArb, nameArb, argObjArb, async (id, name, args) => {
        const registry = new ToolRegistry(); // empty allow-list
        const call: ToolCall = { id, name, arguments: args };
        const result = await dispatchToolCall(registry, call);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('TOOL_NOT_ALLOWED');
        expect(result.toolCallId).toBe(id);
        expect(result.name).toBe(name);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 5: When a registered tool's validate() rejects the arguments,
  // dispatch returns TOOL_BAD_ARGUMENTS and the handler is never invoked.
  it('Property 5: registered tool with invalid args → TOOL_BAD_ARGUMENTS, handler not called', async () => {
    await fc.assert(
      fc.asyncProperty(idArb, argObjArb, async (id, args) => {
        let handlerCalls = 0;
        const registry = new ToolRegistry().register({
          name: 'strict',
          validate: () => undefined, // always reject
          handler: () => {
            handlerCalls += 1;
            return 'should-not-run';
          },
        });
        const result = await dispatchToolCall(registry, { id, name: 'strict', arguments: args });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('TOOL_BAD_ARGUMENTS');
        expect(handlerCalls).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 6: A registered tool whose handler throws yields
  // TOOL_EXECUTION_FAILED (never propagates the throw).
  it('Property 6: handler throw → TOOL_EXECUTION_FAILED (never throws out)', async () => {
    await fc.assert(
      fc.asyncProperty(idArb, argObjArb, fc.string(), async (id, args, msg) => {
        const registry = new ToolRegistry().register({
          name: 'boom',
          validate: (a) => a,
          handler: () => {
            throw new Error(msg);
          },
        });
        const result = await dispatchToolCall(registry, { id, name: 'boom', arguments: args });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('TOOL_EXECUTION_FAILED');
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 7: A registered tool with valid args returns ok:true carrying
  // the handler output and echoing the tool call id + name.
  it('Property 7: registered tool with valid args → ok:true with handler output', async () => {
    await fc.assert(
      fc.asyncProperty(idArb, argObjArb, async (id, args) => {
        const registry = new ToolRegistry().register({
          name: 'echo',
          validate: (a) => a,
          handler: (a) => ({ echoed: a }),
        });
        const result = await dispatchToolCall(registry, { id, name: 'echo', arguments: args });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.toolCallId).toBe(id);
        expect(result.name).toBe('echo');
        expect(result.output).toEqual({ echoed: args });
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 8: dispatchToolCalls returns exactly one result per input call,
  // in order, and never throws regardless of the mix of (un)registered tools.
  it('Property 8: dispatchToolCalls yields one result per call, in order', async () => {
    const registry = new ToolRegistry().register({
      name: 'known',
      validate: (a) => a,
      handler: () => 'ok',
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(idArb, fc.constantFrom('known', 'unknown'), argObjArb), { maxLength: 8 }),
        async (entries) => {
          const calls: ToolCall[] = entries.map(([id, name, args]) => ({ id, name, arguments: args }));
          const results = await dispatchToolCalls(registry, calls);
          expect(results.length).toBe(calls.length);
          results.forEach((r, i) => {
            expect(r.name).toBe(calls[i].name);
            expect(r.toolCallId).toBe(calls[i].id);
            expect(r.ok).toBe(calls[i].name === 'known');
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
