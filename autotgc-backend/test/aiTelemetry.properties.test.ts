/**
 * Property-based tests for the AgentOps telemetry module
 * (`src/infra/aiTelemetry.ts`).
 *
 * These cover the agent-harness "AgentOps" layer:
 *  - `InstrumentedContentGenerator` transparency + outcome classification,
 *  - the PURE, numeric-safe `aggregateAiTelemetry` summary,
 *  - the bounded `InMemoryAiTelemetrySink` ring buffer.
 *
 * House style (mirrors `aiTextClient-generate.properties.test.ts`):
 *  - async properties use `fc.asyncProperty` + `await fc.assert`,
 *  - each test is tagged `// Feature: agent-harness, Property {N}: {text}`,
 *  - every property runs >= 100 generated cases.
 *
 * Determinism: latency is driven by an injected fake `TelemetryClock` (no
 * wall-clock), records are gathered by an in-test fake sink, and no network or
 * real AI provider is ever touched. NOTE: property tests explore the input
 * space on every run, so a previously-green run can still surface a new edge
 * case later — treat any failure as a real signal, not flakiness.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  InstrumentedContentGenerator,
  InMemoryAiTelemetrySink,
  aggregateAiTelemetry,
  type AiCallRecord,
  type AiCallOutcome,
  type AiTelemetrySink,
  type TelemetryClock,
} from '../src/infra/aiTelemetry';
import type { ContentGenerator } from '../src/strategy/personaService';
import { AppError, type AllowedStatus } from '../src/infra/errors';

// --- test doubles ------------------------------------------------------------

/** Inner generator that always RESOLVES a fixed string. */
class FixedResolveGenerator implements ContentGenerator {
  constructor(private readonly value: string) {}
  async generateContent(): Promise<string> {
    return this.value;
  }
}

/** Inner generator that always THROWS a fixed error object (by reference). */
class ThrowingGenerator implements ContentGenerator {
  constructor(private readonly error: unknown) {}
  async generateContent(): Promise<string> {
    throw this.error;
  }
}

/** Sink that simply collects every record it receives. */
class CollectingSink implements AiTelemetrySink {
  readonly records: AiCallRecord[] = [];
  record(record: AiCallRecord): void {
    this.records.push(record);
  }
}

/**
 * Deterministic clock that returns a fixed, strictly increasing sequence of
 * values. `InstrumentedContentGenerator` calls `now()` once for `startedAt` and
 * once inside `emit`, so feeding `[start, start + latency]` makes the recorded
 * `latencyMs` exactly `latency`. Extra calls clamp to the final value.
 */
class SequenceClock implements TelemetryClock {
  private i = 0;
  constructor(private readonly values: readonly number[]) {}
  now(): number {
    const v = this.values[Math.min(this.i, this.values.length - 1)];
    this.i += 1;
    return v;
  }
}

// --- generators --------------------------------------------------------------

const modelArb: fc.Arbitrary<string> = fc.constantFrom(
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'some-other-model',
);

const errorCodeArb: fc.Arbitrary<string> = fc.constantFrom(
  'AI_NOT_CONFIGURED',
  'AI_REQUEST_FAILED',
  'AI_BAD_RESPONSE',
);

/** Allowed error statuses from the restricted status-code set. */
const allowedErrorStatusArb: fc.Arbitrary<AllowedStatus> = fc.constantFrom<AllowedStatus>(
  400,
  401,
  403,
  404,
  409,
  423,
  500,
  502,
);

/** Non-negative epoch-ish integer (kept inside the 32-bit-ish safe band). */
const startedAtArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 2_000_000_000 });

/** Prompt latency in ms — finite and >= 0 by construction. */
const latencyArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 60_000 });

/** A single AiCallRecord with the field shapes the module documents. */
const aiCallRecordArb: fc.Arbitrary<AiCallRecord> = fc.record({
  model: modelArb,
  latencyMs: latencyArb,
  outcome: fc.constantFrom<AiCallOutcome>('SUCCESS', 'AI_ERROR', 'UNKNOWN_ERROR'),
  errorCode: fc.option(errorCodeArb, { nil: undefined }),
  promptChars: fc.integer({ min: 0, max: 100_000 }),
  startedAt: startedAtArb,
});

// --- tests -------------------------------------------------------------------

describe('agent-harness properties (aiTelemetry)', () => {
  // Feature: agent-harness, Property 1: Transparent SUCCESS instrumentation
  // For any inner generator that resolves a string, the wrapper returns that
  // exact string and emits exactly one SUCCESS record carrying the configured
  // model, promptChars === prompt.length, and a finite latencyMs >= 0 (made
  // deterministic via the injected fake clock).
  it('Property 1: resolving inner ⇒ same string + exactly one SUCCESS record (model/promptChars/latency)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        modelArb,
        startedAtArb,
        latencyArb,
        async (output, prompt, model, start, latency) => {
          const sink = new CollectingSink();
          const clock = new SequenceClock([start, start + latency]);
          const wrapper = new InstrumentedContentGenerator(
            new FixedResolveGenerator(output),
            sink,
            model,
            clock,
          );

          const result = await wrapper.generateContent(prompt);

          expect(result).toBe(output);
          expect(sink.records.length).toBe(1);

          const rec = sink.records[0];
          expect(rec.outcome).toBe('SUCCESS');
          expect(rec.model).toBe(model);
          expect(rec.promptChars).toBe(prompt.length);
          expect(rec.errorCode).toBeUndefined();
          expect(rec.startedAt).toBe(start);
          expect(Number.isFinite(rec.latencyMs)).toBe(true);
          expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
          expect(rec.latencyMs).toBe(latency);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 2: Error passthrough + outcome classification
  // For any inner that throws an AppError, the wrapper re-throws the SAME error
  // (same instance + code) and records ONE AI_ERROR with errorCode === code.
  // For an inner that throws a non-AppError Error, it re-throws the SAME error
  // and records ONE UNKNOWN_ERROR with errorCode undefined.
  it('Property 2: throwing inner ⇒ re-throws same error; AppError⇒AI_ERROR(code), Error⇒UNKNOWN_ERROR(undefined)', async () => {
    const appErrorArb: fc.Arbitrary<{ isApp: true; error: AppError }> = fc
      .record({ status: allowedErrorStatusArb, message: fc.string(), code: errorCodeArb })
      .map(({ status, message, code }) => ({ isApp: true as const, error: new AppError(status, message, code) }));

    const plainErrorArb: fc.Arbitrary<{ isApp: false; error: Error }> = fc
      .string()
      .map((message) => ({ isApp: false as const, error: new Error(message) }));

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(appErrorArb, plainErrorArb),
        fc.string(),
        modelArb,
        startedAtArb,
        latencyArb,
        async (thrownSpec, prompt, model, start, latency) => {
          const sink = new CollectingSink();
          const clock = new SequenceClock([start, start + latency]);
          const wrapper = new InstrumentedContentGenerator(
            new ThrowingGenerator(thrownSpec.error),
            sink,
            model,
            clock,
          );

          let caught: unknown;
          try {
            await wrapper.generateContent(prompt);
          } catch (e) {
            caught = e;
          }

          // Re-thrown unchanged (same reference) so AI-OPTIONAL fallback runs.
          expect(caught).toBe(thrownSpec.error);
          expect(sink.records.length).toBe(1);

          const rec = sink.records[0];
          expect(rec.model).toBe(model);
          expect(rec.startedAt).toBe(start);

          if (thrownSpec.isApp) {
            expect(caught).toBeInstanceOf(AppError);
            expect((caught as AppError).code).toBe(thrownSpec.error.code);
            expect(rec.outcome).toBe('AI_ERROR');
            expect(rec.errorCode).toBe(thrownSpec.error.code);
          } else {
            expect(caught).not.toBeInstanceOf(AppError);
            expect(rec.outcome).toBe('UNKNOWN_ERROR');
            expect(rec.errorCode).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 3: aggregateAiTelemetry numeric safety
  // Empty batch ⇒ every rate/percentile is INSUFFICIENT_DATA and all counts 0.
  // Any non-empty batch ⇒ counts partition totalCalls, errorRate/successRate
  // are numbers in [0,1] that sum to 1, and p50/p95 are actual elements of the
  // (all-finite) latency set within [min,max].
  it('Property 3: empty ⇒ INSUFFICIENT_DATA/zero; non-empty ⇒ consistent counts, rates, percentiles', () => {
    // Empty array: numeric-safe sentinels, never NaN / 0% / divide-by-zero.
    const empty = aggregateAiTelemetry([]);
    expect(empty.totalCalls).toBe(0);
    expect(empty.successCount).toBe(0);
    expect(empty.aiErrorCount).toBe(0);
    expect(empty.unknownErrorCount).toBe(0);
    expect(empty.errorRate).toBe('INSUFFICIENT_DATA');
    expect(empty.successRate).toBe('INSUFFICIENT_DATA');
    expect(empty.p50LatencyMs).toBe('INSUFFICIENT_DATA');
    expect(empty.p95LatencyMs).toBe('INSUFFICIENT_DATA');
    expect(empty.errorCodeCounts).toEqual({});

    fc.assert(
      fc.property(fc.array(aiCallRecordArb, { minLength: 1, maxLength: 200 }), (records) => {
        const s = aggregateAiTelemetry(records);

        expect(s.totalCalls).toBe(records.length);
        expect(s.successCount + s.aiErrorCount + s.unknownErrorCount).toBe(records.length);

        // Non-empty ⇒ rates are numbers in [0,1] summing to 1.
        expect(typeof s.errorRate).toBe('number');
        expect(typeof s.successRate).toBe('number');
        const errorRate = s.errorRate as number;
        const successRate = s.successRate as number;
        expect(errorRate).toBeGreaterThanOrEqual(0);
        expect(errorRate).toBeLessThanOrEqual(1);
        expect(successRate).toBeGreaterThanOrEqual(0);
        expect(successRate).toBeLessThanOrEqual(1);
        expect(errorRate + successRate).toBeCloseTo(1, 10);

        // All generated latencies are finite & >= 0, so percentiles are real
        // members of the latency set inside [min,max].
        const latencies = records.map((r) => r.latencyMs);
        const min = Math.min(...latencies);
        const max = Math.max(...latencies);
        expect(typeof s.p50LatencyMs).toBe('number');
        expect(typeof s.p95LatencyMs).toBe('number');
        const p50 = s.p50LatencyMs as number;
        const p95 = s.p95LatencyMs as number;
        expect(latencies.includes(p50)).toBe(true);
        expect(latencies.includes(p95)).toBe(true);
        expect(p50).toBeGreaterThanOrEqual(min);
        expect(p50).toBeLessThanOrEqual(max);
        expect(p95).toBeGreaterThanOrEqual(min);
        expect(p95).toBeLessThanOrEqual(max);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 4: Percentile monotonicity
  // For any non-empty set of finite, non-negative latencies, p50 <= p95.
  it('Property 4: p50 <= p95 for any non-empty finite/non-negative latency set', () => {
    fc.assert(
      fc.property(fc.array(latencyArb, { minLength: 1, maxLength: 200 }), (latencies) => {
        const records: AiCallRecord[] = latencies.map((latencyMs, i) => ({
          model: 'm',
          latencyMs,
          outcome: 'SUCCESS',
          promptChars: 0,
          startedAt: i,
        }));
        const s = aggregateAiTelemetry(records);
        expect(typeof s.p50LatencyMs).toBe('number');
        expect(typeof s.p95LatencyMs).toBe('number');
        expect(s.p50LatencyMs as number).toBeLessThanOrEqual(s.p95LatencyMs as number);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: agent-harness, Property 5: InMemoryAiTelemetrySink boundedness
  // After recording N > capacity records, snapshot().length === capacity and it
  // contains exactly the most recent `capacity` records (oldest evicted).
  it('Property 5: sink retains exactly the most recent `capacity` records once N > capacity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 250 }),
        fc.array(aiCallRecordArb, { minLength: 1, maxLength: 64 }),
        (capacity, extra, baseRecords) => {
          const total = capacity + extra; // strictly greater than capacity
          // Uniquely identifiable records via a strictly increasing startedAt.
          const records: AiCallRecord[] = Array.from({ length: total }, (_, i) => ({
            ...baseRecords[i % baseRecords.length],
            startedAt: i,
          }));

          const sink = new InMemoryAiTelemetrySink(capacity);
          for (const r of records) sink.record(r);

          const snap = sink.snapshot();
          expect(snap.length).toBe(capacity);

          // Oldest evicted: retained window is the trailing `capacity` records.
          const expected = records.slice(total - capacity);
          expect(snap.map((r) => r.startedAt)).toEqual(expected.map((r) => r.startedAt));
          expect(snap[0].startedAt).toBe(total - capacity);
          expect(snap[snap.length - 1].startedAt).toBe(total - 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
