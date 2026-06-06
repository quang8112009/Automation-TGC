/**
 * Property-based tests for the GroundedAssistant engine
 * (`src/infra/groundedAssistant.ts`) — the AI-OPTIONAL "grounded assistant with
 * tools" use-case that composes the agent harness:
 *
 *   grounding → ChatCompleter → runAgentLoop (bounded + governed) → ToolRegistry
 *   → AssistantResult, with a deterministic fallback whenever AI is unavailable.
 *
 * The engine is pure orchestration over an injected `ChatCompleter` seam, so we
 * drive it with a FAKE completer we fully control (scripted per call-index, or
 * throwing). No network, no provider. We assert the AssistantResult invariants
 * the design promises:
 *   - AI-OPTIONAL: a fallback answer can never be flagged `aiGenerated`,
 *   - NEVER THROWS: a missing/erroring completer or exhausted budget all resolve
 *     to a structured AssistantResult with a deterministic fallback answer,
 *   - the `fallbackReason` telemetry mirrors the loop's outcome.
 *
 * House style: each test tagged `// Feature: agent-harness, Property {N}: {text}`;
 * async properties use `fc.asyncProperty` + `await fc.assert`; `{ numRuns: 100 }`.
 *
 * NOTE: property tests generate fresh inputs each run, so they may surface a new
 * edge case (with a shrunk counterexample) on any given run rather than only on
 * code change — that is expected and a feature, not flakiness.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  GroundedAssistant,
  type AssistantRequest,
  type AssistantResult,
  type FallbackBuilder,
} from '../src/infra/groundedAssistant';
import type { ChatCompleter, ChatMessage, ChatTurn } from '../src/infra/aiAgentLoop';
import { ToolRegistry, type ToolCall } from '../src/infra/aiToolCalls';

// --- fakes / helpers ---------------------------------------------------------

/**
 * A fully-controlled fake completer. Its behavior is a pure function of the
 * (zero-based) call index plus the live messages/toolNames the assistant passes
 * in. Throwing synchronously inside the callback rejects the returned promise,
 * exercising the engine's COMPLETER_ERROR fallback path.
 */
class FakeCompleter implements ChatCompleter {
  public calls = 0;
  constructor(
    private readonly behavior: (
      callIndex: number,
      messages: readonly ChatMessage[],
      toolNames: readonly string[],
    ) => ChatTurn | Promise<ChatTurn>,
  ) {}

  async complete(messages: readonly ChatMessage[], toolNames: readonly string[]): Promise<ChatTurn> {
    const index = this.calls;
    this.calls += 1;
    return this.behavior(index, messages, toolNames);
  }
}

/** Registry with exactly one allow-listed `echo` tool (validate=identity, handler=identity). */
function echoRegistry(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'echo',
    validate: (a) => a,
    handler: (a) => a,
  });
}

/** Deterministic, grounded fallback: prefixes the user message so it is always non-empty. */
const fallback: FallbackBuilder = (req) => 'FB:' + req.userMessage;

/** Build the engine with a given (possibly undefined) completer. */
function makeAssistant(
  completer: ChatCompleter | undefined,
  maxIterations?: number,
): GroundedAssistant {
  return new GroundedAssistant(completer, echoRegistry(), fallback, { maxIterations });
}

// --- generators --------------------------------------------------------------

const requestArb: fc.Arbitrary<AssistantRequest> = fc.record({
  systemPrompt: fc.string({ maxLength: 60 }),
  groundingContext: fc.string({ maxLength: 80 }),
  userMessage: fc.string({ maxLength: 60 }),
});

const idArb = fc.string({ minLength: 1, maxLength: 12 });
const argObjArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { maxKeys: 4 },
);

/** Whitespace-only strings (spaces, tabs, newlines, CR) of length >= 1. */
const whitespaceArb = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { minLength: 1, maxLength: 8 })
  .map((cs) => cs.join(''));

/** Assert the universal AssistantResult shape invariants on every result. */
function assertResultShape(result: AssistantResult): void {
  expect(typeof result.answer).toBe('string');
  expect(result.answer.length).toBeGreaterThan(0);
  expect(typeof result.aiGenerated).toBe('boolean');
  expect(Array.isArray(result.toolResults)).toBe(true);
  expect(typeof result.iterations).toBe('number');
  expect(result.iterations).toBeGreaterThanOrEqual(0);
  // AI-OPTIONAL telemetry contract: fallbackReason iff !aiGenerated.
  if (result.aiGenerated) {
    expect(result.fallbackReason).toBeUndefined();
  } else {
    expect(result.fallbackReason).toBeDefined();
  }
}

// =============================================================================
describe('agent-harness — GroundedAssistant AI-OPTIONAL engine', () => {
  // ---------------------------------------------------------------------------
  // Feature: agent-harness, Property 1: With NO completer configured (undefined), the engine never
  // invokes AI — it returns the deterministic fallback: aiGenerated:false, answer === fallback(req),
  // iterations 0, no tool results, fallbackReason 'NO_COMPLETER'. Never throws.
  it('Property 1: no completer → deterministic fallback (NO_COMPLETER), iterations 0, no tools', async () => {
    await fc.assert(
      fc.asyncProperty(requestArb, async (request) => {
        const assistant = makeAssistant(undefined);
        const result = await assistant.run(request);

        assertResultShape(result);
        expect(result.aiGenerated).toBe(false);
        expect(result.answer).toBe(fallback(request));
        expect(result.iterations).toBe(0);
        expect(result.toolResults).toEqual([]);
        expect(result.fallbackReason).toBe('NO_COMPLETER');
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Feature: agent-harness, Property 2: A completer that returns non-empty final text on the first
  // turn yields the AI path: aiGenerated:true, answer === trimmed text, iterations 1, no
  // fallbackReason.
  it('Property 2: immediate non-empty text → aiGenerated:true, answer trimmed, iterations 1', async () => {
    // Generate content with non-whitespace so the trimmed text is non-empty.
    const contentArb = fc
      .tuple(fc.string({ maxLength: 20 }), fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 20 }))
      .map(([pre, core, post]) => pre + core.replace(/\s/g, 'x') + post)
      .filter((s) => s.trim().length > 0);

    await fc.assert(
      fc.asyncProperty(requestArb, contentArb, async (request, content) => {
        const completer = new FakeCompleter(() => ({ kind: 'text', content }));
        const assistant = makeAssistant(completer);
        const result = await assistant.run(request);

        assertResultShape(result);
        expect(result.aiGenerated).toBe(true);
        expect(result.answer).toBe(content.trim());
        expect(result.iterations).toBe(1);
        expect(result.fallbackReason).toBeUndefined();
        expect(completer.calls).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Feature: agent-harness, Property 3: A completer that ALWAYS requests the registered echo tool
  // (never returns text) exhausts the bounded budget → AI-OPTIONAL fallback: aiGenerated:false,
  // answer === fallback(req), fallbackReason 'MAX_ITERATIONS', and toolResults is non-empty (the
  // governed loop actually ran tools). Never throws.
  it('Property 3: always-echo-tool completer → MAX_ITERATIONS fallback with non-empty tool trail', async () => {
    const maxItArb = fc.integer({ min: 1, max: 6 });
    await fc.assert(
      fc.asyncProperty(requestArb, idArb, argObjArb, maxItArb, async (request, id, args, maxIterations) => {
        const completer = new FakeCompleter(() => ({
          kind: 'tool_calls',
          toolCalls: [{ id, name: 'echo', arguments: args }],
        }));
        const assistant = makeAssistant(completer, maxIterations);
        const result = await assistant.run(request);

        assertResultShape(result);
        expect(result.aiGenerated).toBe(false);
        expect(result.answer).toBe(fallback(request));
        expect(result.fallbackReason).toBe('MAX_ITERATIONS');
        expect(result.toolResults.length).toBeGreaterThan(0);
        // Every recorded tool result is the successfully dispatched echo.
        expect(result.toolResults.every((r) => r.ok)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Feature: agent-harness, Property 4: A completer whose complete() rejects makes the engine resolve
  // (never throw) with the deterministic fallback: aiGenerated:false, fallbackReason
  // 'COMPLETER_ERROR', answer === fallback(req) — regardless of the thrown value's type.
  it('Property 4: completer error → COMPLETER_ERROR fallback (never throws)', async () => {
    const thrownArb = fc.oneof(
      fc.string().map((m) => new Error(m)),
      fc.string(),
      fc.integer(),
      fc.constant(null),
      fc.constant(undefined),
    );
    await fc.assert(
      fc.asyncProperty(requestArb, thrownArb, async (request, thrown) => {
        const completer: ChatCompleter = {
          complete: async () => {
            throw thrown;
          },
        };
        const assistant = makeAssistant(completer);
        const result = await assistant.run(request);

        assertResultShape(result);
        expect(result.aiGenerated).toBe(false);
        expect(result.fallbackReason).toBe('COMPLETER_ERROR');
        expect(result.answer).toBe(fallback(request));
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Feature: agent-harness, Property 5: A completer returning an empty tool_calls list ([]) makes no
  // progress → AI-OPTIONAL fallback: fallbackReason 'EMPTY_TOOL_TURN', aiGenerated:false, answer ===
  // fallback(req). Never throws.
  it('Property 5: empty tool_calls [] → EMPTY_TOOL_TURN fallback', async () => {
    await fc.assert(
      fc.asyncProperty(requestArb, async (request) => {
        const completer = new FakeCompleter(() => ({ kind: 'tool_calls', toolCalls: [] }));
        const assistant = makeAssistant(completer);
        const result = await assistant.run(request);

        assertResultShape(result);
        expect(result.fallbackReason).toBe('EMPTY_TOOL_TURN');
        expect(result.aiGenerated).toBe(false);
        expect(result.answer).toBe(fallback(request));
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Feature: agent-harness, Property 6: A completer returning WHITESPACE-ONLY text is treated as a
  // non-answer (run() checks result.text.trim().length > 0), so the engine falls back:
  // aiGenerated:false with a fallbackReason set. The loop itself reports ok:true, so the engine maps
  // it to 'EMPTY_TOOL_TURN'. Never throws.
  it('Property 6: whitespace-only text → treated as non-answer → fallback (aiGenerated:false)', async () => {
    await fc.assert(
      fc.asyncProperty(requestArb, whitespaceArb, async (request, ws) => {
        const completer = new FakeCompleter(() => ({ kind: 'text', content: ws }));
        const assistant = makeAssistant(completer);
        const result = await assistant.run(request);

        assertResultShape(result);
        expect(result.aiGenerated).toBe(false);
        expect(result.answer).toBe(fallback(request));
        // ok:true loop with empty trimmed text → engine's EMPTY_TOOL_TURN mapping.
        expect(result.fallbackReason).toBe('EMPTY_TOOL_TURN');
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Feature: agent-harness, Property 7: Master invariant — for ANY per-call completer behavior
  // (text / echo-tool / unknown-tool / empty-tool / throw, chosen per call by fast-check) and any
  // maxIterations, run() NEVER throws and always returns a well-formed AssistantResult: a non-empty
  // string answer, a boolean aiGenerated, and the telemetry contract (fallbackReason set iff
  // aiGenerated===false, undefined iff true). When aiGenerated===false the answer is exactly the
  // deterministic fallback.
  it('Property 7: never throws; always a well-formed AssistantResult honoring the AI-OPTIONAL contract', async () => {
    const modeArb = fc.constantFrom('text', 'tool_echo', 'tool_unknown', 'empty', 'throw');
    const scriptArb = fc.array(modeArb, { minLength: 1, maxLength: 20 });
    const maxItArb = fc.oneof(
      fc.integer({ min: -3, max: 20 }),
      fc.constant(undefined),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
    );

    await fc.assert(
      fc.asyncProperty(requestArb, scriptArb, maxItArb, async (request, script, maxIterations) => {
        const completer = new FakeCompleter((i): ChatTurn => {
          const mode = script[Math.min(i, script.length - 1)];
          switch (mode) {
            case 'text':
              // May be whitespace-sensitive; use clearly non-empty content here.
              return { kind: 'text', content: `done-${i}` };
            case 'tool_echo':
              return { kind: 'tool_calls', toolCalls: [{ id: `e${i}`, name: 'echo', arguments: {} } as ToolCall] };
            case 'tool_unknown':
              return { kind: 'tool_calls', toolCalls: [{ id: `u${i}`, name: 'mystery', arguments: {} } as ToolCall] };
            case 'empty':
              return { kind: 'tool_calls', toolCalls: [] };
            case 'throw':
              throw new Error(`provider-fail-${i}`);
            default:
              return { kind: 'text', content: 'done' };
          }
        });

        const assistant = makeAssistant(completer, maxIterations);
        // Resolving at all (no rejection) is itself the "never throws" guarantee.
        const result = await assistant.run(request);

        assertResultShape(result);
        if (!result.aiGenerated) {
          // Every fallback path returns the deterministic, grounded answer verbatim.
          expect(result.answer).toBe(fallback(request));
          expect(['NO_COMPLETER', 'COMPLETER_ERROR', 'MAX_ITERATIONS', 'EMPTY_TOOL_TURN']).toContain(
            result.fallbackReason,
          );
        } else {
          // AI path: the answer is the model's trimmed text, never the fallback marker semantics.
          expect(result.fallbackReason).toBeUndefined();
          expect(result.answer.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
