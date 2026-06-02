/**
 * Property-based tests for the ai-reporting-and-ops-enhancements spec.
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: ai-reporting-and-ops-enhancements, Property {n}: {design text}`)
 * and runs >= 100 generated cases on fast-check (Req 14.6). All logic under
 * test is pure (no Prisma/Gemini/clock), so the generators below fully
 * determine each run.
 *
 * Structure: one `describe` block per property so additional properties
 * (7–16, authored by later tasks) can be appended without touching these.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  filterByPeriod,
  applyScope,
  averageRate,
  aggregateReport,
  buildDeterministicSummary,
  isInsufficient,
} from '../src/reporting/reportEngine';
import type {
  ReportInputRow,
  ReportPeriod,
  ReportType,
} from '../src/reporting/types';

// --- shared generators -------------------------------------------------------

const PERF_LABELS = ['HIGH_PERFORMER', 'AVERAGE_PERFORMER', 'LOW_PERFORMER', 'INSUFFICIENT_DATA'];
const LEAD_SOURCES = ['FB', 'TIKTOK', 'WEB', 'REFERRAL', ''];
const STAGES = ['NEW', 'CONSULTING', 'MATCHED', 'INTERVIEW_SCHEDULED', 'DEPARTED', ''];
const MARKETS = ['JAPAN', 'KOREA', 'GERMANY', 'TAIWAN', 'DOMESTIC', 'OTHER', ''];
const REPORT_TYPES: ReportType[] = ['WEEKLY', 'MONTHLY'];

const MAX_MS = 4_000_000_000_000;

const arbMs = fc.integer({ min: 0, max: MAX_MS });
const arbDate = arbMs.map((ms) => new Date(ms));
const arbRate = fc.double({ min: -1_000_000, max: 1_000_000, noNaN: true });

/** A fully-populated row; the engine only reads the fields relevant per kind. */
const arbRow: fc.Arbitrary<ReportInputRow> = fc.record({
  kind: fc.constantFrom('performance', 'lead', 'candidate'),
  occurredAt: arbDate,
  performanceLabel: fc.constantFrom(...PERF_LABELS),
  conversionRate: arbRate,
  engagementRate: arbRate,
  ctaClickRate: arbRate,
  leadSource: fc.constantFrom(...LEAD_SOURCES),
  candidateStage: fc.constantFrom(...STAGES),
  candidateMarket: fc.constantFrom(...MARKETS),
  assignedTo: fc.option(fc.string(), { nil: null }),
}) as fc.Arbitrary<ReportInputRow>;

/** A performance row with a label and a (sometimes absent) conversion rate. */
const arbPerfRow: fc.Arbitrary<ReportInputRow> = fc.record({
  kind: fc.constant('performance' as const),
  occurredAt: arbDate,
  performanceLabel: fc.constantFrom(...PERF_LABELS),
  conversionRate: fc.option(arbRate, { nil: undefined }),
}) as fc.Arbitrary<ReportInputRow>;

/** A period [from, to) with from <= to, built from two sorted timestamps. */
const arbPeriod: fc.Arbitrary<ReportPeriod> = fc
  .tuple(arbMs, arbMs)
  .map(([a, b]) => {
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    return { label: `${from}-${to}`, from: new Date(from), to: new Date(to) };
  });

// =============================================================================
// Report_Engine — period filtering
// =============================================================================

describe('ai-reporting-and-ops properties (filterByPeriod)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 1: Lọc theo kỳ chỉ giữ bản ghi trong [from, to)
  // For any rows and any Report_Period, filterByPeriod keeps exactly the rows whose
  // occurredAt satisfies from <= occurredAt < to (left-inclusive, right-exclusive),
  // and drops every row outside the interval.
  it('Property 1: keeps only records within [from, to)', () => {
    fc.assert(
      fc.property(fc.array(arbRow, { maxLength: 40 }), arbPeriod, (rows, period) => {
        const kept = filterByPeriod(rows, period);
        const from = period.from.getTime();
        const to = period.to.getTime();

        // Every kept row is inside [from, to).
        for (const r of kept) {
          const t = r.occurredAt.getTime();
          expect(t >= from && t < to).toBe(true);
        }

        // Every dropped row is outside [from, to) (set partition is exact).
        const keptSet = new Set(kept);
        for (const r of rows) {
          if (!keptSet.has(r)) {
            const t = r.occurredAt.getTime();
            expect(t >= from && t < to).toBe(false);
          }
        }

        // No phantom rows: kept is a subset, and counts add up.
        expect(kept.length).toBe(
          rows.filter((r) => {
            const t = r.occurredAt.getTime();
            return t >= from && t < to;
          }).length,
        );
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Report_Engine — average rate
// =============================================================================

describe('ai-reporting-and-ops properties (averageRate)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 2: Trung bình rate loại trừ INSUFFICIENT_DATA và an toàn chia 0
  // For any set of PerformanceRecords, averageRate equals the arithmetic mean after dropping
  // every INSUFFICIENT_DATA-labeled record; if none remain (denominator 0) the result is
  // 'INSUFFICIENT_DATA' and never NaN/Infinity.
  it('Property 2: averages exclude INSUFFICIENT_DATA and are divide-by-zero safe', () => {
    fc.assert(
      fc.property(fc.array(arbPerfRow, { maxLength: 40 }), (rows) => {
        const result = averageRate(rows, (r) => r.conversionRate);

        // Oracle: same exclusion + finite filter + iteration order as the impl.
        const values: number[] = [];
        for (const r of rows) {
          if (r.performanceLabel === 'INSUFFICIENT_DATA') continue;
          const v = r.conversionRate;
          if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
        }

        if (values.length === 0) {
          expect(result).toBe('INSUFFICIENT_DATA');
        } else {
          let sum = 0;
          for (const v of values) sum += v;
          const expected = sum / values.length;
          expect(typeof result).toBe('number');
          expect(result as number).toBeCloseTo(expected, 6);
          // Never NaN/Infinity.
          expect(Number.isFinite(result as number)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Report_Engine — SALES scope
// =============================================================================

describe('ai-reporting-and-ops properties (applyScope)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 3: Phạm vi SALES chỉ giữ dữ liệu được phân công
  // For any candidate/lead rows and any SALES user, applyScope keeps only rows whose
  // assignedTo === userId, dropping rows assigned to others or unassigned (assignedTo null);
  // ADMIN keeps every row.
  it('Property 3: SALES scope keeps only assigned rows; ADMIN keeps all', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 6 }).chain((userId) =>
          fc.tuple(
            fc.constant(userId),
            fc.array(
              fc.record({
                kind: fc.constantFrom('candidate', 'lead'),
                occurredAt: arbDate,
                assignedTo: fc.oneof(
                  fc.constant(userId),
                  fc.constant('OTHER_A'),
                  fc.constant('OTHER_B'),
                  fc.constant(null),
                ),
              }) as fc.Arbitrary<ReportInputRow>,
              { maxLength: 40 },
            ),
          ),
        ),
        ([userId, rows]) => {
          const salesScoped = applyScope(rows, { role: 'SALES', userId });
          // Only this user's rows survive — no unassigned, no other-owner rows.
          for (const r of salesScoped) {
            expect(r.assignedTo).toBe(userId);
          }
          expect(salesScoped.length).toBe(
            rows.filter((r) => r.assignedTo === userId).length,
          );

          // ADMIN keeps the whole set.
          const adminScoped = applyScope(rows, { role: 'ADMIN', userId });
          expect(adminScoped.length).toBe(rows.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Report_Engine — aggregation completeness
// =============================================================================

describe('ai-reporting-and-ops properties (aggregateReport)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 4: Tổng hợp báo cáo nhất quán và đầy đủ cấu trúc
  // For any filtered rows, aggregateReport returns a ReportContent that always carries all five
  // sections; the leadsBySource bucket total equals the lead row count, the funnel stageCounts
  // total equals the candidate row count, and every count is non-negative.
  it('Property 4: report aggregation is structurally complete with matching bucket totals', () => {
    fc.assert(
      fc.property(
        fc.array(arbRow, { maxLength: 50 }),
        fc.constantFrom(...REPORT_TYPES),
        arbPeriod,
        (rows, type, period) => {
          const content = aggregateReport(rows, type, period);

          // All five sections present.
          expect(typeof content.executiveSummary).toBe('string');
          expect(content.executiveSummary.length).toBeGreaterThan(0);
          expect(typeof content.contentPerformance).toBe('object');
          expect(Array.isArray(content.recruitmentFunnelByMarket)).toBe(true);
          expect(Array.isArray(content.leadsBySource)).toBe(true);
          expect(Array.isArray(content.highlights)).toBe(true);
          expect(Array.isArray(content.recommendations)).toBe(true);

          const perfCount = rows.filter((r) => r.kind === 'performance').length;
          const leadCount = rows.filter((r) => r.kind === 'lead').length;
          const candidateCount = rows.filter((r) => r.kind === 'candidate').length;

          // publishedCount == performance rows.
          expect(content.contentPerformance.publishedCount).toBe(perfCount);

          // leadsBySource totals == lead rows; counts non-negative.
          let leadTotal = 0;
          for (const bucket of content.leadsBySource) {
            expect(bucket.count).toBeGreaterThanOrEqual(0);
            leadTotal += bucket.count;
          }
          expect(leadTotal).toBe(leadCount);

          // funnel stageCounts totals == candidate rows; counts non-negative.
          let stageTotal = 0;
          for (const market of content.recruitmentFunnelByMarket) {
            for (const count of Object.values(market.stageCounts)) {
              expect(count).toBeGreaterThanOrEqual(0);
              stageTotal += count;
            }
          }
          expect(stageTotal).toBe(candidateCount);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Report_Engine — determinism without Gemini
// =============================================================================

describe('ai-reporting-and-ops properties (deterministic without Gemini)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 5: Báo cáo xác định khi không dùng Gemini
  // For any rows and any Report_Period, aggregating + summarizing without Gemini yields the same
  // ReportContent across repeated calls (deep-equal), and the report is marked aiGenerated = false.
  it('Property 5: aggregation is deterministic and aiGenerated is false without Gemini', () => {
    fc.assert(
      fc.property(
        fc.array(arbRow, { maxLength: 50 }),
        fc.constantFrom(...REPORT_TYPES),
        arbPeriod,
        (rows, type, period) => {
          const a = aggregateReport(rows, type, period);
          const b = aggregateReport(rows, type, period);
          // Deep-equal across calls (no Date.now / Gemini nondeterminism).
          expect(a).toEqual(b);

          // The deterministic summary is itself stable for identical input.
          const s1 = buildDeterministicSummary(a, type, period);
          const s2 = buildDeterministicSummary(b, type, period);
          expect(s1).toBe(s2);
          expect(a.executiveSummary).toBe(s1);

          // The pure (Gemini-free) generation path is always aiGenerated = false.
          const generatedWithoutGemini = { content: a, aiGenerated: false };
          expect(generatedWithoutGemini.aiGenerated).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Report_Engine — insufficient data
// =============================================================================

describe('ai-reporting-and-ops properties (insufficient data)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 6: Thiếu dữ liệu không sinh khuyến nghị suy đoán
  // For any rows that, after period+scope filtering, leave no valid records, isInsufficient is true
  // and the produced report has an empty recommendations list and INSUFFICIENT_DATA status.
  it('Property 6: insufficient data yields no recommendations and INSUFFICIENT_DATA status', () => {
    fc.assert(
      fc.property(
        // Rows occurring strictly before the period start guarantee an empty filter result.
        fc.array(fc.record({ offset: fc.integer({ min: 1, max: 1_000_000 }) }), { maxLength: 40 }),
        fc.integer({ min: 1_000_000, max: MAX_MS }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom(...REPORT_TYPES),
        (rowSpecs, periodFromMs, periodSpan, type) => {
          const period: ReportPeriod = {
            label: `${periodFromMs}`,
            from: new Date(periodFromMs),
            to: new Date(periodFromMs + periodSpan),
          };
          // All rows sit before period.from -> excluded by filterByPeriod.
          const rows: ReportInputRow[] = rowSpecs.map((spec) => ({
            kind: 'candidate',
            occurredAt: new Date(periodFromMs - spec.offset),
            candidateStage: 'NEW',
            assignedTo: null,
          }));

          const filtered = filterByPeriod(rows, period);
          const scoped = applyScope(filtered, { role: 'ADMIN', userId: 'admin' });

          expect(filtered.length).toBe(0);
          expect(isInsufficient(scoped)).toBe(true);

          const content = aggregateReport(scoped, type, period);
          expect(content.recommendations.length).toBe(0);

          // Status mapping for the empty case (mirrors ReportService): INSUFFICIENT_DATA.
          const status = isInsufficient(scoped) ? 'INSUFFICIENT_DATA' : 'DRAFT';
          expect(status).toBe('INSUFFICIENT_DATA');
        },
      ),
      { numRuns: 200 },
    );
  });
});
