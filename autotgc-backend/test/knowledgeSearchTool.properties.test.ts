/**
 * Property-based tests for `src/infra/knowledgeSearchTool.ts`, the first
 * concrete READ-ONLY tool wired into the agent harness. Covers the pure
 * argument validator (`validateKnowledgeSearchArgs`), the pure projection
 * (`projectHits`), the `ToolDefinition` factory (`buildKnowledgeSearchTool`),
 * its registry/dispatch integration, and the offered JSON schema.
 *
 * House style: each test tagged `// Feature: agent-harness, Property {N}: {text}`;
 * async properties use `fc.asyncProperty` + `await fc.assert`; `{ numRuns: 100 }`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  validateKnowledgeSearchArgs,
  projectHits,
  buildKnowledgeSearchTool,
  KNOWLEDGE_SEARCH_TOOL_SCHEMA,
  type KnowledgeSearchPort,
} from '../src/infra/knowledgeSearchTool';
import { ToolRegistry, dispatchToolCall, type ToolCall } from '../src/infra/aiToolCalls';

// --- helpers -----------------------------------------------------------------

type Row = { title: string; category: string; content: string };

/**
 * A recording fake of the search port. Captures every `[query, limit]` pair the
 * tool passes through and returns a fixed set of rows. Deterministic — no
 * network, no clock.
 */
function makeFakePort(rows: ReadonlyArray<Row>): KnowledgeSearchPort & { calls: Array<[string, number | undefined]> } {
  const calls: Array<[string, number | undefined]> = [];
  return {
    calls,
    async search(query: string, limit?: number) {
      calls.push([query, limit]);
      return rows;
    },
  };
}

const SNIPPET_MAX = 280;
const HITS_CEILING = 10;

// --- generators --------------------------------------------------------------

const rowArb: fc.Arbitrary<Row> = fc.record({
  title: fc.string({ maxLength: 40 }),
  category: fc.string({ maxLength: 20 }),
  // Mix short and long content so the snippet truncation branch is exercised.
  content: fc.oneof(
    fc.string({ maxLength: 100 }),
    fc.string({ minLength: 281, maxLength: 600 }),
    fc.string({ minLength: SNIPPET_MAX, maxLength: SNIPPET_MAX }), // exactly 280 (boundary)
  ),
});

const rowsArb = fc.array(rowArb, { maxLength: 25 });

// A non-empty, non-whitespace query string.
const nonEmptyQueryArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

// =============================================================================
// Property 1 — validateKnowledgeSearchArgs: query handling
// =============================================================================
describe('agent-harness — validateKnowledgeSearchArgs query (Property 1)', () => {
  // Feature: agent-harness, Property 1: query that is missing, not a string, empty, or
  // whitespace-only → undefined (rejected); a non-empty string → { query: trimmed }.
  it('Property 1: invalid query → undefined; non-empty string → { query: trimmed }', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(''),
          fc.constant('   '),
          fc.constant('\t\n  '),
        ),
        (badQuery) => {
          const args: Record<string, unknown> = badQuery === undefined ? {} : { query: badQuery };
          expect(validateKnowledgeSearchArgs(args)).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(nonEmptyQueryArb, (q) => {
        const result = validateKnowledgeSearchArgs({ query: q });
        expect(result).toBeDefined();
        expect(result?.query).toBe(q.trim());
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 2 — validateKnowledgeSearchArgs: limit clamping
// =============================================================================
describe('agent-harness — validateKnowledgeSearchArgs limit (Property 2)', () => {
  // Feature: agent-harness, Property 2: a provided non-finite limit (NaN/Infinity/'abc')
  // → undefined (whole args rejected); a finite limit is floored then clamped to [1,10];
  // an absent limit leaves result.limit undefined.
  it('Property 2: non-finite limit → reject; finite limit floored+clamped to [1,10]; absent → undefined', () => {
    // Non-finite provided limits reject the whole args object.
    fc.assert(
      fc.property(fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'abc', {}), (bad) => {
        expect(validateKnowledgeSearchArgs({ query: 'visa', limit: bad })).toBeUndefined();
      }),
      { numRuns: 100 },
    );

    // Finite limits are floored then clamped into [1,10].
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.double({ min: -1000, max: 1000, noNaN: true })),
        (n) => {
          const result = validateKnowledgeSearchArgs({ query: 'visa', limit: n });
          expect(result).toBeDefined();
          const floored = Math.floor(n);
          const expected = floored < 1 ? 1 : floored > HITS_CEILING ? HITS_CEILING : floored;
          expect(result?.limit).toBe(expected);
          expect(result?.limit).toBeGreaterThanOrEqual(1);
          expect(result?.limit).toBeLessThanOrEqual(HITS_CEILING);
        },
      ),
      { numRuns: 100 },
    );

    // Spot-check the exact mappings called out in the spec.
    const cases: Array<[number, number]> = [
      [0, 1],
      [-5, 1],
      [1, 1],
      [5, 5],
      [10, 10],
      [1000, 10],
      [3.9, 3],
    ];
    for (const [input, expected] of cases) {
      expect(validateKnowledgeSearchArgs({ query: 'visa', limit: input })?.limit).toBe(expected);
    }

    // Absent limit → result.limit undefined (but args still valid).
    fc.assert(
      fc.property(nonEmptyQueryArb, (q) => {
        const result = validateKnowledgeSearchArgs({ query: q });
        expect(result).toBeDefined();
        expect(result?.limit).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 3 — projectHits: bounded, faithful projection
// =============================================================================
describe('agent-harness — projectHits projection (Property 3)', () => {
  // Feature: agent-harness, Property 3: for ANY rows array, output length === min(len,10);
  // title/category preserved positionally; snippet === content when content.length<=280,
  // else content.slice(0,280)+'…'; every snippet length <= 281.
  it('Property 3: length capped at 10, title/category preserved, snippet bounded (<=281)', () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const hits = projectHits(rows);
        expect(hits.length).toBe(Math.min(rows.length, HITS_CEILING));
        hits.forEach((hit, i) => {
          const row = rows[i];
          expect(hit.title).toBe(row.title);
          expect(hit.category).toBe(row.category);
          if (row.content.length > SNIPPET_MAX) {
            expect(hit.snippet).toBe(`${row.content.slice(0, SNIPPET_MAX)}…`);
          } else {
            expect(hit.snippet).toBe(row.content);
          }
          // Snippet is bounded: at most 280 chars + the single ellipsis char.
          expect(hit.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX + 1);
        });
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 4 — buildKnowledgeSearchTool: ToolDefinition + handler wiring
// =============================================================================
describe('agent-harness — buildKnowledgeSearchTool (Property 4)', () => {
  // Feature: agent-harness, Property 4: the factory returns a ToolDefinition named
  // 'knowledge_search'; its handler calls the injected port.search with the validated
  // query+limit and returns { hits: projectHits(rows) }.
  it('Property 4: name knowledge_search; handler delegates to port.search and projects hits', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyQueryArb, fc.integer({ min: 1, max: 10 }), rowsArb, async (q, limit, rows) => {
        const port = makeFakePort(rows);
        const tool = buildKnowledgeSearchTool(port);
        expect(tool.name).toBe('knowledge_search');

        const validated = tool.validate({ query: q, limit });
        expect(validated).toBeDefined();
        if (!validated) return;

        const output = await tool.handler(validated);
        // Handler forwarded the validated query + limit to the port.
        expect(port.calls).toEqual([[q.trim(), limit]]);
        // Output is the bounded projection of the rows the port returned.
        expect(output).toEqual({ hits: projectHits(rows) });
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 5 — registry + dispatch integration
// =============================================================================
describe('agent-harness — registry/dispatch integration (Property 5)', () => {
  // Feature: agent-harness, Property 5: registered in a ToolRegistry, a valid call dispatches
  // ok:true with output { hits }; an invalid call (empty query) dispatches ok:false
  // TOOL_BAD_ARGUMENTS and the port.search is NEVER called (no read on bad args).
  it('Property 5: valid args → ok:true {hits}; empty query → TOOL_BAD_ARGUMENTS, port never called', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyQueryArb, rowsArb, async (q, rows) => {
        const port = makeFakePort(rows);
        const registry = new ToolRegistry().register(buildKnowledgeSearchTool(port));

        const validCall: ToolCall = { id: 'c1', name: 'knowledge_search', arguments: { query: q } };
        const okResult = await dispatchToolCall(registry, validCall);
        expect(okResult.ok).toBe(true);
        if (okResult.ok) {
          expect(okResult.name).toBe('knowledge_search');
          expect(okResult.output).toEqual({ hits: projectHits(rows) });
        }
        expect(port.calls.length).toBe(1);
      }),
      { numRuns: 100 },
    );

    // Invalid args (empty/whitespace query) → bad arguments, handler/port untouched.
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('', '   ', '\n\t'), rowsArb, async (badQuery, rows) => {
        const port = makeFakePort(rows);
        const registry = new ToolRegistry().register(buildKnowledgeSearchTool(port));

        const badCall: ToolCall = { id: 'c2', name: 'knowledge_search', arguments: { query: badQuery } };
        const result = await dispatchToolCall(registry, badCall);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe('TOOL_BAD_ARGUMENTS');
        }
        // No read should occur when arguments are rejected.
        expect(port.calls.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 6 — KNOWLEDGE_SEARCH_TOOL_SCHEMA shape
// =============================================================================
describe('agent-harness — KNOWLEDGE_SEARCH_TOOL_SCHEMA (Property 6)', () => {
  // Feature: agent-harness, Property 6: the offered JSON schema names the tool
  // 'knowledge_search', declares parameters.type 'object', and requires 'query'.
  it('Property 6: schema name, parameters.type object, required includes query', () => {
    // This is a fixed-shape invariant; assert it holds across repeated reads
    // (the constant must be stable and not mutated by importers).
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(KNOWLEDGE_SEARCH_TOOL_SCHEMA.name).toBe('knowledge_search');
        expect(KNOWLEDGE_SEARCH_TOOL_SCHEMA.parameters.type).toBe('object');
        expect(Array.isArray(KNOWLEDGE_SEARCH_TOOL_SCHEMA.parameters.required)).toBe(true);
        expect(KNOWLEDGE_SEARCH_TOOL_SCHEMA.parameters.required as string[]).toContain('query');
      }),
      { numRuns: 100 },
    );
  });
});
