/**
 * AgentOps telemetry for AI text generation (harness layer: AgentOps).
 *
 * Provides observability for every AI text call WITHOUT touching the
 * `ContentGenerator` seam contract or the AI-OPTIONAL discipline:
 *
 *  - `InstrumentedContentGenerator` is a transparent decorator that wraps ANY
 *    `ContentGenerator` (e.g. `AiTextClient`), times each `generateContent`
 *    call, classifies the outcome (success / typed AI error / unknown error),
 *    and emits an `AiCallRecord` to an injected sink. It then re-throws on
 *    failure exactly as the inner client would, so consumers' existing
 *    try/catch → deterministic fallback path is unchanged.
 *  - `aggregateAiTelemetry` is a PURE function that turns a batch of records
 *    into a summary (call counts, success/error/fallback rates, latency
 *    percentiles). It is numeric-safe: with zero records it reports
 *    `INSUFFICIENT_DATA` rather than dividing by zero (steering: numeric
 *    safety), so dashboards never show misleading 0%/NaN rates.
 *
 * No secret value is ever recorded: only prompt LENGTH, model id, latency, and
 * the outcome/error code are captured — never the prompt text, the response, or
 * the API key.
 */
import type { ContentGenerator } from '../strategy/personaService';
import { AppError } from './errors';

/** Outcome classification for a single AI text call. */
export type AiCallOutcome = 'SUCCESS' | 'AI_ERROR' | 'UNKNOWN_ERROR';

/**
 * A single recorded AI text call. Contains NO secret and NO free-text content —
 * only metadata safe to log/aggregate.
 */
export interface AiCallRecord {
  /** Provider/model label the call targeted (e.g. 'deepseek-v4-flash'). */
  readonly model: string;
  /** Wall-clock latency of the call in milliseconds (>= 0). */
  readonly latencyMs: number;
  /** Outcome classification. */
  readonly outcome: AiCallOutcome;
  /**
   * For AI_ERROR outcomes, the typed AppError code
   * (AI_NOT_CONFIGURED / AI_REQUEST_FAILED / AI_BAD_RESPONSE); otherwise
   * `undefined`.
   */
  readonly errorCode?: string;
  /** Length (chars) of the prompt sent — never the prompt text itself. */
  readonly promptChars: number;
  /** Epoch milliseconds when the call started. */
  readonly startedAt: number;
}

/** Sink that receives telemetry records. Implementations must not throw. */
export interface AiTelemetrySink {
  record(record: AiCallRecord): void;
}

/** A no-op sink (telemetry disabled). */
export const NOOP_AI_TELEMETRY_SINK: AiTelemetrySink = {
  record(): void {
    /* intentionally empty */
  },
};

/** Monotonic-ish clock seam (injectable for tests). */
export interface TelemetryClock {
  now(): number;
}

const SYSTEM_CLOCK: TelemetryClock = { now: () => Date.now() };

/**
 * Transparent decorator over a `ContentGenerator` that emits one
 * `AiCallRecord` per call and re-throws failures unchanged. Implements the same
 * `ContentGenerator` interface, so it is a drop-in wrapper at composition time.
 */
export class InstrumentedContentGenerator implements ContentGenerator {
  constructor(
    private readonly inner: ContentGenerator,
    private readonly sink: AiTelemetrySink,
    /** Model/provider label recorded with each call. */
    private readonly model: string,
    private readonly clock: TelemetryClock = SYSTEM_CLOCK,
  ) {}

  async generateContent(prompt: string): Promise<string> {
    const startedAt = this.clock.now();
    try {
      const out = await this.inner.generateContent(prompt);
      this.emit(startedAt, 'SUCCESS', undefined, prompt);
      return out;
    } catch (err) {
      if (err instanceof AppError) {
        this.emit(startedAt, 'AI_ERROR', err.code, prompt);
      } else {
        this.emit(startedAt, 'UNKNOWN_ERROR', undefined, prompt);
      }
      // Re-throw unchanged so the consumer's AI-OPTIONAL fallback still runs.
      throw err;
    }
  }

  private emit(startedAt: number, outcome: AiCallOutcome, errorCode: string | undefined, prompt: string): void {
    const elapsed = this.clock.now() - startedAt;
    const latencyMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
    try {
      this.sink.record({
        model: this.model,
        latencyMs,
        outcome,
        errorCode,
        promptChars: typeof prompt === 'string' ? prompt.length : 0,
        startedAt,
      });
    } catch {
      // A telemetry sink must never break the call path.
    }
  }
}

/** Aggregated telemetry summary over a batch of records. */
export interface AiTelemetrySummary {
  totalCalls: number;
  successCount: number;
  aiErrorCount: number;
  unknownErrorCount: number;
  /** Fraction of calls that failed (any error) — `INSUFFICIENT_DATA` when no calls. */
  errorRate: number | 'INSUFFICIENT_DATA';
  /** Fraction of calls that succeeded — `INSUFFICIENT_DATA` when no calls. */
  successRate: number | 'INSUFFICIENT_DATA';
  /** Median latency (ms) — `INSUFFICIENT_DATA` when no calls. */
  p50LatencyMs: number | 'INSUFFICIENT_DATA';
  /** 95th-percentile latency (ms) — `INSUFFICIENT_DATA` when no calls. */
  p95LatencyMs: number | 'INSUFFICIENT_DATA';
  /** Count of each typed AI error code observed. */
  errorCodeCounts: Readonly<Record<string, number>>;
}

/** Nearest-rank percentile over a NON-empty sorted ascending array. */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  // Nearest-rank: rank = ceil(p/100 * N), clamped to [1, N].
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
}

/**
 * PURE aggregation of telemetry records. Numeric-safe: an empty batch yields
 * `INSUFFICIENT_DATA` for every rate/percentile (never NaN or a misleading 0%).
 * Deterministic: depends only on the input array.
 */
export function aggregateAiTelemetry(records: readonly AiCallRecord[]): AiTelemetrySummary {
  const totalCalls = records.length;
  let successCount = 0;
  let aiErrorCount = 0;
  let unknownErrorCount = 0;
  const errorCodeCounts: Record<string, number> = {};
  const latencies: number[] = [];

  for (const r of records) {
    if (Number.isFinite(r.latencyMs) && r.latencyMs >= 0) latencies.push(r.latencyMs);
    switch (r.outcome) {
      case 'SUCCESS':
        successCount += 1;
        break;
      case 'AI_ERROR':
        aiErrorCount += 1;
        if (r.errorCode) errorCodeCounts[r.errorCode] = (errorCodeCounts[r.errorCode] ?? 0) + 1;
        break;
      default:
        unknownErrorCount += 1;
        break;
    }
  }

  if (totalCalls === 0) {
    return {
      totalCalls: 0,
      successCount: 0,
      aiErrorCount: 0,
      unknownErrorCount: 0,
      errorRate: 'INSUFFICIENT_DATA',
      successRate: 'INSUFFICIENT_DATA',
      p50LatencyMs: 'INSUFFICIENT_DATA',
      p95LatencyMs: 'INSUFFICIENT_DATA',
      errorCodeCounts: {},
    };
  }

  const errorTotal = aiErrorCount + unknownErrorCount;
  const sorted = latencies.slice().sort((a, b) => a - b);

  return {
    totalCalls,
    successCount,
    aiErrorCount,
    unknownErrorCount,
    errorRate: errorTotal / totalCalls,
    successRate: successCount / totalCalls,
    p50LatencyMs: sorted.length > 0 ? percentile(sorted, 50) : 'INSUFFICIENT_DATA',
    p95LatencyMs: sorted.length > 0 ? percentile(sorted, 95) : 'INSUFFICIENT_DATA',
    errorCodeCounts,
  };
}

/**
 * A simple bounded in-memory ring-buffer sink. Keeps the most recent `capacity`
 * records so an operator endpoint can call `aggregateAiTelemetry(sink.snapshot())`.
 * Bounded so it can never exhaust memory.
 */
export class InMemoryAiTelemetrySink implements AiTelemetrySink {
  private readonly buffer: AiCallRecord[] = [];

  constructor(private readonly capacity: number = 1000) {}

  record(record: AiCallRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  /** Defensive copy of the retained records (oldest → newest). */
  snapshot(): AiCallRecord[] {
    return this.buffer.slice();
  }

  /** Current summary over the retained window. */
  summary(): AiTelemetrySummary {
    return aggregateAiTelemetry(this.buffer);
  }
}
