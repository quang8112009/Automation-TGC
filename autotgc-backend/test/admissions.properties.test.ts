/**
 * Property-based tests for the study-abroad-ai-advisor-suite Admissions group
 * (Group 1 — admission likelihood scoring + Reach/Match/Safety banding + gap
 * suggestions).
 *
 * Three DESIGN-canonical correctness properties are exercised here, each tagged
 * with `// Feature: study-abroad-ai-advisor-suite, Property {n}: {design text}`
 * and run on >= 100 generated cases with fast-check. The modules under test are
 * pure + framework-free (no Prisma/Fastify), so they are property-tested
 * directly with smart generators that intelligently span the input space
 * (missing / zero / negative / non-finite signals, valid + invalid JLPT levels,
 * published + absent thresholds, every selectivity tier).
 *
 * Mirrors the structure of `analytics-feedback.properties.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { scoreAdmission, normalizeGpa } from '../src/admissions/admissionScorer';
import { classifyBand, bandRank } from '../src/admissions/admissionBand';
import { suggestGaps } from '../src/admissions/gapSuggestion';
import type {
  AcademicSignals,
  ProgramThresholds,
  SelectivityTier,
  AdmissionBandValue,
  GapItem,
} from '../src/admissions/types';
import type { StudentFinance, ProgramFinance } from '../src/partners/scholarshipMatcher';

// --- shared constants & smart generators ------------------------------------

const BANDS: AdmissionBandValue[] = ['REACH', 'MATCH', 'SAFETY'];
const JLPT_VALID = ['N5', 'N4', 'N3', 'N2', 'N1'] as const;
// Mix of valid (incl. lowercase/padded which the modules normalize) and invalid.
const JLPT_INPUTS = ['N5', 'N4', 'N3', 'N2', 'N1', ' n3 ', 'INVALID', '', 'N0'] as const;
const SELECTIVITIES: Array<SelectivityTier | null> = ['HIGH', 'MEDIUM', 'LOW', null];

/** Optional finite number that may be missing (null), zero, or negative. */
function optNum(min: number, max: number): fc.Arbitrary<number | null> {
  return fc.option(fc.float({ min, max, noNaN: true }), { nil: null });
}

/**
 * Optional published threshold: null (absent), a finite value (possibly
 * zero/negative), or an invalid non-finite value to exercise the malformed
 * threshold branch. Modules guard against non-finite via clamping /
 * INSUFFICIENT_DATA, so results stay safe.
 */
function thrNum(min: number, max: number): fc.Arbitrary<number | null> {
  return fc.oneof(
    { weight: 2, arbitrary: fc.constant(null) },
    { weight: 6, arbitrary: fc.float({ min, max, noNaN: true }) },
    { weight: 1, arbitrary: fc.constantFrom(Infinity, -Infinity, NaN) },
  );
}

const academicArb: fc.Arbitrary<AcademicSignals> = fc.record({
  gpa: optNum(-5, 15),
  gpaScale: optNum(-2, 12), // includes <= 0 to exercise the divide-safety precondition
  ielts: optNum(-1, 10),
  toefl: optNum(-10, 130),
  jlpt: fc.option(fc.constantFrom(...JLPT_INPUTS), { nil: null }),
  educationLevel: fc.option(fc.constantFrom('BACHELOR', 'HIGH_SCHOOL', 'MASTER'), { nil: null }),
});

const thresholdsArb: fc.Arbitrary<ProgramThresholds> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 6 }),
  name: fc.string({ minLength: 1, maxLength: 8 }),
  country: fc.constantFrom('USA', 'UK', 'CANADA', 'JAPAN', 'AUSTRALIA'),
  minGpa: thrNum(-1, 11),
  minIelts: thrNum(-1, 10),
  minToefl: thrNum(-10, 130),
  minJlpt: fc.option(fc.constantFrom('N5', 'N4', 'N3', 'N2', 'N1', 'INVALID'), { nil: null }),
  selectivityTier: fc.option(fc.constantFrom<SelectivityTier>('HIGH', 'MEDIUM', 'LOW'), {
    nil: null,
  }),
});

const studentFinanceArb: fc.Arbitrary<StudentFinance> = fc.record({
  budgetPerYearVndM: fc.option(fc.float({ min: -50, max: 2000, noNaN: true }), { nil: undefined }),
  gpa: fc.option(fc.float({ min: 0, max: 10, noNaN: true }), { nil: undefined }),
  ielts: fc.option(fc.float({ min: 0, max: 9, noNaN: true }), { nil: undefined }),
});

const programFinanceArb: fc.Arbitrary<ProgramFinance> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 6 }),
  name: fc.string({ minLength: 1, maxLength: 8 }),
  country: fc.constantFrom('USA', 'UK', 'CANADA', 'JAPAN', 'AUSTRALIA'),
  tuitionPerYearVndM: fc.option(fc.float({ min: -10, max: 1000, noNaN: true }), { nil: null }),
  livingCostPerYearVndM: fc.option(fc.float({ min: -10, max: 800, noNaN: true }), { nil: null }),
  scholarshipMaxPct: fc.option(fc.float({ min: -10, max: 120, noNaN: true }), { nil: null }),
  minGpa: fc.option(fc.float({ min: 0, max: 11, noNaN: true }), { nil: null }),
  minIelts: fc.option(fc.float({ min: 0, max: 10, noNaN: true }), { nil: null }),
});

const financeArb = fc.record({ student: studentFinanceArb, program: programFinanceArb });

/** True when a numeric result sits in the closed unit interval and is finite. */
function inUnitInterval(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

// =============================================================================
// Property 1 — Admission_Scorer (task 2.4)
// =============================================================================

describe('study-abroad-ai-advisor-suite admissions properties (scoring)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 1: Điểm trúng tuyển trong [0,1], xác định, an toàn chuẩn hóa GPA, và INSUFFICIENT_DATA khi thiếu tín hiệu
  // Validates Requirements 2.1,2.2,2.3,2.4,2.5,2.6,2.7,2.8,19.1.
  it('Property 1: admission score stays in [0,1] or INSUFFICIENT_DATA, is deterministic, GPA-divide-safe, and signals INSUFFICIENT_DATA on missing inputs', () => {
    fc.assert(
      fc.property(academicArb, thresholdsArb, financeArb, (academic, thresholds, finance) => {
        const result = scoreAdmission(academic, thresholds, finance);

        // (Req 2.1, 19.1) result is either the missing-data label or a finite number in [0,1].
        if (result === 'INSUFFICIENT_DATA') {
          expect(result).toBe('INSUFFICIENT_DATA');
        } else {
          expect(typeof result).toBe('number');
          expect(Number.isNaN(result as number)).toBe(false);
          expect(Number.isFinite(result as number)).toBe(true);
          expect(inUnitInterval(result as number)).toBe(true);
        }

        // (Req 2.2) determinism: a second call on identical input yields an identical result.
        const again = scoreAdmission(academic, thresholds, finance);
        expect(again).toStrictEqual(result);

        // (Req 2.4, 2.6) GPA normalization is gated on gpaScale > 0 — a non-positive scale
        // can never force a division; normalizeGpa returns undefined instead.
        if (typeof academic.gpaScale === 'number' && academic.gpaScale <= 0) {
          expect(normalizeGpa(academic.gpa, academic.gpaScale)).toBeUndefined();
        }

        // (Req 2.5) When the program publishes a required academic threshold but the candidate
        // supplies NONE of the academic signals, the pair is INSUFFICIENT_DATA — financial fit
        // never rescues missing academic data.
        const withSignalThreshold: ProgramThresholds = { ...thresholds, minIelts: 6.5 };
        const emptyAcademic: AcademicSignals = {};
        expect(scoreAdmission(emptyAcademic, withSignalThreshold, finance)).toBe('INSUFFICIENT_DATA');
      }),
      { numRuns: 100 },
    );
  });

  // A focused, deterministic companion check: a published GPA threshold with a non-positive
  // gpaScale (and no other published academic signal) must NOT divide — it yields
  // INSUFFICIENT_DATA, never a NaN/Infinity score (Req 2.4, 2.6).
  it('Property 1 (focused): non-positive gpaScale never forces a GPA divide', () => {
    const finance = { student: {}, program: { id: 'p', name: 'P', country: 'USA' } };
    for (const scale of [0, -1, -10]) {
      expect(normalizeGpa(8, scale)).toBeUndefined();
      const onlyGpaThresholds: ProgramThresholds = { id: 'p', name: 'P', country: 'USA', minGpa: 7 };
      const r = scoreAdmission({ gpa: 8, gpaScale: scale }, onlyGpaThresholds, finance);
      expect(r).toBe('INSUFFICIENT_DATA');
    }
  });
});

// =============================================================================
// Property 2 — Admission_Band (task 2.5)
// =============================================================================

describe('study-abroad-ai-advisor-suite admissions properties (banding)', () => {
  // Score input union: a finite score in [0,1], the INSUFFICIENT_DATA label, or a non-finite value.
  const scoreInputArb: fc.Arbitrary<number | 'INSUFFICIENT_DATA'> = fc.oneof(
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.constant('INSUFFICIENT_DATA' as const),
    fc.constantFrom(NaN, Infinity, -Infinity),
  );

  // Feature: study-abroad-ai-advisor-suite, Property 2: Phân band xác định, nhận biết độ chọn lọc, đơn điệu theo điểm, và passthrough INSUFFICIENT_DATA
  // Validates Requirements 3.1,3.2,3.4,3.5,3.6,3.7,19.2.
  it('Property 2: banding passes through INSUFFICIENT_DATA/non-finite, assigns exactly one band for numeric scores, is deterministic, and is monotonic in score at fixed selectivity', () => {
    fc.assert(
      fc.property(
        scoreInputArb,
        fc.constantFrom(...SELECTIVITIES),
        // Two finite scores (wider than [0,1] to also probe clamping) for the monotonicity check.
        fc.float({ min: -0.5, max: 1.5, noNaN: true }),
        fc.float({ min: -0.5, max: 1.5, noNaN: true }),
        (scoreInput, selectivity, x, y) => {
          const band = classifyBand(scoreInput, selectivity);

          if (scoreInput === 'INSUFFICIENT_DATA' || !Number.isFinite(scoreInput as number)) {
            // (Req 3.4, 3.7) the missing-data label and non-finite scores pass through unbanded.
            expect(band).toBe('INSUFFICIENT_DATA');
          } else {
            // (Req 3.1) a finite numeric score maps to exactly one of REACH|MATCH|SAFETY.
            expect(BANDS).toContain(band);
          }

          // (Req 3.2) determinism: same (score, selectivity) → same band.
          expect(classifyBand(scoreInput, selectivity)).toStrictEqual(band);

          // (Req 3.5) monotonicity at FIXED selectivity: a higher score never yields a
          // less-favourable band (SAFETY ≻ MATCH ≻ REACH).
          const s1 = Math.min(x, y);
          const s2 = Math.max(x, y);
          const b1 = classifyBand(s1, selectivity);
          const b2 = classifyBand(s2, selectivity);
          // finite scores always band, so both are concrete bands here.
          expect(BANDS).toContain(b1);
          expect(BANDS).toContain(b2);
          expect(bandRank(b2 as AdmissionBandValue)).toBeGreaterThanOrEqual(
            bandRank(b1 as AdmissionBandValue),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 3 — Gap_Suggestion (task 2.6)
// =============================================================================

describe('study-abroad-ai-advisor-suite admissions properties (gap suggestion)', () => {
  /** Look up the published threshold for a gap's dimension straight from the program. */
  function publishedTargetFor(dimension: GapItem['dimension'], thresholds: ProgramThresholds) {
    switch (dimension) {
      case 'GPA':
        return thresholds.minGpa;
      case 'IELTS':
        return thresholds.minIelts;
      case 'TOEFL':
        return thresholds.minToefl;
      case 'JLPT':
        return thresholds.minJlpt;
    }
  }

  // Feature: study-abroad-ai-advisor-suite, Property 3: Gợi ý gap chỉ dùng ngưỡng chương trình, xác định, và phân biệt rỗng-đã-xác minh với INSUFFICIENT_DATA
  // Validates Requirements 4.1,4.2,4.3,4.4,4.5,4.6,4.7.
  it('Property 3: gap suggestions use only program thresholds, are deterministic, and distinguish verified-empty from INSUFFICIENT_DATA', () => {
    fc.assert(
      fc.property(academicArb, thresholdsArb, (academic, thresholds) => {
        const result = suggestGaps(academic, thresholds);

        // Shape: a GapItem[] or the missing-data label.
        const isArray = Array.isArray(result);
        expect(isArray || result === 'INSUFFICIENT_DATA').toBe(true);

        if (isArray) {
          // (Req 4.1, 4.2) every emitted target is EXACTLY a threshold the program published —
          // never a fabricated number. Compare against the thresholds object itself.
          for (const gap of result as GapItem[]) {
            expect(gap.target).toBe(publishedTargetFor(gap.dimension, thresholds));
          }
        }

        // (Req 4.5) determinism: same input → same list in the same order (deep-equal).
        const again = suggestGaps(academic, thresholds);
        expect(again).toStrictEqual(result);

        // (Req 4.4) when the program publishes NO comparable threshold on any dimension, the
        // result is INSUFFICIENT_DATA — distinct from a verified-empty array.
        const noThresholds: ProgramThresholds = {
          id: thresholds.id,
          name: thresholds.name,
          country: thresholds.country,
          minGpa: null,
          minIelts: null,
          minToefl: null,
          minJlpt: null,
          selectivityTier: thresholds.selectivityTier,
        };
        expect(suggestGaps(academic, noThresholds)).toBe('INSUFFICIENT_DATA');
      }),
      { numRuns: 100 },
    );
  });

  // A focused, deterministic companion check: a fully-verified candidate that meets a published
  // threshold yields a verified-empty array `[]`, distinct from INSUFFICIENT_DATA (Req 4.3).
  it('Property 3 (focused): meeting every published & verifiable threshold yields verified-empty []', () => {
    const thresholds: ProgramThresholds = {
      id: 'p',
      name: 'P',
      country: 'USA',
      minIelts: 6.0,
    };
    const academic: AcademicSignals = { ielts: 7.5 };
    expect(suggestGaps(academic, thresholds)).toStrictEqual([]);
  });
});
