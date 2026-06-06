/**
 * Property-based tests for the study-abroad-ai-advisor-suite spec — Group 5
 * (Roadmap & readiness). Mirrors the structure/conventions of
 * `analytics-feedback.properties.test.ts`: each test is tagged with its
 * DESIGN-canonical property number/text and runs >= 100 generated cases on
 * fast-check. The pure cores under test (`estimateRoadmap`, `scoreReadiness`)
 * are framework-free, so no fakes/clock injection are needed — the inputs are
 * generated directly.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { estimateRoadmap } from '../src/roadmap/roadmapEstimator';
import { scoreReadiness } from '../src/roadmap/readinessScorer';
import { scoreFinance } from '../src/partners/scholarshipMatcher';
import type { StudentFinance, ProgramFinance } from '../src/partners/scholarshipMatcher';
import type { ChecklistItemLike } from '../src/recruitment/documents/completion';
import type { AcademicSignals, ProgramThresholds } from '../src/admissions/types';
import type { KnowledgeNote } from '../src/roadmap/types';

// --- shared helpers / generators --------------------------------------------

const DOC_STATUSES = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'] as const;
const JLPT_LEVELS = new Set(['N5', 'N4', 'N3', 'N2', 'N1']);

/** A non-negative money figure (million VND) that may also be exactly 0 or null. */
const moneyOrNull = fc.oneof(
  fc.constant(0),
  fc.constant(null),
  fc.float({ min: 0, max: 5000, noNaN: true }),
);

const studentFinanceGen: fc.Arbitrary<StudentFinance> = fc.record(
  {
    budgetPerYearVndM: fc.float({ min: 0, max: 5000, noNaN: true }),
    gpa: fc.float({ min: 0, max: 10, noNaN: true }),
    ielts: fc.float({ min: 0, max: 9, noNaN: true }),
  },
  { requiredKeys: [] },
);

const programFinanceGen: fc.Arbitrary<ProgramFinance> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 6 }),
  name: fc.string({ minLength: 1, maxLength: 8 }),
  country: fc.constantFrom('USA', 'UK', 'Japan', 'Canada', 'Atlantis'),
  tuitionPerYearVndM: moneyOrNull,
  livingCostPerYearVndM: moneyOrNull,
  scholarshipMaxPct: fc.option(fc.float({ min: 0, max: 100, noNaN: true }), { nil: null }),
  minGpa: fc.option(fc.float({ min: 0, max: 10, noNaN: true }), { nil: null }),
  minIelts: fc.option(fc.float({ min: 0, max: 9, noNaN: true }), { nil: null }),
});

const knowledgeNoteGen: fc.Arbitrary<KnowledgeNote> = fc.record({
  title: fc.string({ maxLength: 20 }),
  content: fc.string({ maxLength: 40 }),
});

/** Optional expected post-graduation annual income (million VND): undefined | null | number. */
const incomeGen = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.float({ min: 0, max: 3000, noNaN: true }),
);

/** Whether a program actually carries usable cost data (oracle mirroring the module). */
function hasCostData(p: ProgramFinance): boolean {
  return (p.tuitionPerYearVndM ?? 0) > 0 || (p.livingCostPerYearVndM ?? 0) > 0;
}

const academicSignalsGen: fc.Arbitrary<AcademicSignals> = fc.record(
  {
    gpa: fc.option(fc.float({ min: 0, max: 10, noNaN: true }), { nil: undefined }),
    gpaScale: fc.option(fc.constantFrom(0, 4, 10), { nil: undefined }),
    ielts: fc.option(fc.float({ min: 0, max: 9, noNaN: true }), { nil: undefined }),
    toefl: fc.option(fc.float({ min: 0, max: 120, noNaN: true }), { nil: undefined }),
    jlpt: fc.option(fc.constantFrom('N5', 'N4', 'N3', 'N2', 'N1', 'bogus'), { nil: undefined }),
    educationLevel: fc.option(fc.constantFrom('', 'BACHELOR', 'HIGH_SCHOOL'), { nil: undefined }),
  },
  { requiredKeys: [] },
);

const programThresholdsGen: fc.Arbitrary<ProgramThresholds> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 6 }),
  name: fc.string({ minLength: 1, maxLength: 8 }),
  country: fc.constantFrom('USA', 'UK', 'Japan', 'Canada'),
  minGpa: fc.option(fc.float({ min: 0, max: 10, noNaN: true }), { nil: null }),
  minIelts: fc.option(fc.float({ min: 0, max: 9, noNaN: true }), { nil: null }),
  minToefl: fc.option(fc.float({ min: 0, max: 120, noNaN: true }), { nil: null }),
  minJlpt: fc.option(fc.constantFrom('N5', 'N4', 'N3', 'N2', 'N1'), { nil: null }),
  selectivityTier: fc.option(fc.constantFrom('HIGH', 'MEDIUM', 'LOW') as fc.Arbitrary<
    'HIGH' | 'MEDIUM' | 'LOW'
  >, { nil: null }),
});

const checklistItemGen: fc.Arbitrary<ChecklistItemLike> = fc.record({
  required: fc.boolean(),
  status: fc.constantFrom(...DOC_STATUSES),
});

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function jlptValid(s: string | null | undefined): boolean {
  return typeof s === 'string' && JLPT_LEVELS.has(s.trim().toUpperCase());
}

/**
 * Oracle for the "no component is present" condition of `scoreReadiness`,
 * replicating the module's component-presence logic so the test can assert the
 * exact biconditional (no-component ⇔ INSUFFICIENT_DATA, no division).
 */
function readinessHasNoComponent(input: {
  documents: readonly ChecklistItemLike[];
  academic: AcademicSignals;
  thresholds?: ProgramThresholds;
}): boolean {
  const noRequiredDoc = input.documents.every((d) => !d.required);

  const a = input.academic;
  const gpaUsable = isFiniteNum(a.gpa) && isFiniteNum(a.gpaScale) && a.gpaScale > 0;
  const languageProvided = isFiniteNum(a.ielts) || isFiniteNum(a.toefl) || jlptValid(a.jlpt);
  const educationProvided =
    typeof a.educationLevel === 'string' && a.educationLevel.trim().length > 0;
  const noAcademic = !gpaUsable && !languageProvided && !educationProvided;

  const t = input.thresholds;
  const languageTarget =
    !!t && ((isFiniteNum(t.minIelts) && t.minIelts > 0) || jlptValid(t.minJlpt));

  return noRequiredDoc && noAcademic && !languageTarget;
}

// =============================================================================
// Roadmap_Estimator property
// =============================================================================

describe('study-abroad-ai-advisor-suite properties (roadmap estimator)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 9: Ước lượng lộ trình xác định, tái dùng chi phí ròng, và INSUFFICIENT_DATA khi thiếu dữ liệu tài chính
  // Validates Requirements 16.1, 16.2, 16.4, 16.5, 19.8.
  it('Property 9: estimateRoadmap is deterministic, reuses scoreFinance net cost, and surfaces INSUFFICIENT_DATA on missing financial data', () => {
    fc.assert(
      fc.property(
        studentFinanceGen,
        programFinanceGen,
        fc.array(knowledgeNoteGen, { maxLength: 5 }),
        incomeGen,
        (student, program, knowledge, income) => {
          const est1 = estimateRoadmap(student, program, knowledge, income);
          const est2 = estimateRoadmap(student, program, knowledge, income);

          // Deterministic: identical inputs → deep-equal estimates (Req 16.2).
          expect(est2).toEqual(est1);

          // careerNotes / prPathwayNotes are always arrays (Req 16.3).
          expect(Array.isArray(est1.careerNotes)).toBe(true);
          expect(Array.isArray(est1.prPathwayNotes)).toBe(true);

          // Every numeric metric is finite — never NaN/Infinity (Req 16.4, 16.5).
          for (const metric of [est1.netCostPerYearVndM, est1.totalCostVndM, est1.roi]) {
            if (metric !== 'INSUFFICIENT_DATA') {
              expect(typeof metric).toBe('number');
              expect(Number.isFinite(metric as number)).toBe(true);
            }
          }

          if (hasCostData(program)) {
            // Net cost is taken DIRECTLY from scoreFinance — exact reuse (Req 16.1).
            const fin = scoreFinance(student, program);
            expect(est1.netCostPerYearVndM).toBe(fin.netCostPerYearVndM);

            // ROI denominator 0 OR missing income → INSUFFICIENT_DATA (Req 16.4, 16.5).
            const incomeOk = income != null && Number.isFinite(income);
            const net = fin.netCostPerYearVndM;
            if (!incomeOk || !(Number.isFinite(net) && net > 0)) {
              expect(est1.roi).toBe('INSUFFICIENT_DATA');
            }
          } else {
            // No usable cost data → every financial metric is INSUFFICIENT_DATA (Req 16.5).
            expect(est1.netCostPerYearVndM).toBe('INSUFFICIENT_DATA');
            expect(est1.totalCostVndM).toBe('INSUFFICIENT_DATA');
            expect(est1.roi).toBe('INSUFFICIENT_DATA');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Readiness_Scorer property
// =============================================================================

describe('study-abroad-ai-advisor-suite properties (readiness scorer)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 8: Điểm sẵn sàng hồ sơ trong [0,1], xác định, và an toàn chia 0
  // Validates Requirements 18.1, 18.2, 18.4, 18.6, 19.7.
  it('Property 8: scoreReadiness stays in [0,1] (or INSUFFICIENT_DATA with no division), gaps is always an array, and is deterministic', () => {
    fc.assert(
      fc.property(
        fc.array(checklistItemGen, { maxLength: 8 }),
        academicSignalsGen,
        fc.option(programThresholdsGen, { nil: undefined }),
        (documents, academic, thresholds) => {
          const input = { documents, academic, thresholds: thresholds ?? undefined };

          const res1 = scoreReadiness(input);
          const res2 = scoreReadiness(input);

          // Deterministic: same input → deep-equal result (Req 18.2).
          expect(res2).toEqual(res1);

          // gaps is ALWAYS an array (Req 18.5) — even when score is INSUFFICIENT_DATA.
          expect(Array.isArray(res1.gaps)).toBe(true);

          const noComponent = readinessHasNoComponent(input);
          if (noComponent) {
            // No component present → INSUFFICIENT_DATA, NO division performed (Req 18.4).
            expect(res1.score).toBe('INSUFFICIENT_DATA');
          } else {
            // At least one component → numeric score in [0,1], never NaN/Infinity
            // (Req 18.1, 18.6).
            expect(res1.score).not.toBe('INSUFFICIENT_DATA');
            expect(typeof res1.score).toBe('number');
            const score = res1.score as number;
            expect(Number.isFinite(score)).toBe(true);
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
