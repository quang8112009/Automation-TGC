/**
 * Property-based tests for the PURE Scholarship_Matcher engine
 * (`src/partners/scholarshipMatcher.ts`). No Prisma / Fastify — the engine is
 * framework-free + deterministic, so we drive it directly with fast-check.
 *
 * Covers (Feature 2 — Financial & Scholarship Matching):
 *  - scoreFinance: never NaN; net = max(0, total - scholarship); estPct in
 *    [0, scholarshipMaxPct]; affordable === (budget>0 && net<=budget).
 *  - matchScholarships: affordable ranked before unaffordable; affordable sorted
 *    by net asc; only programs carrying cost data appear.
 *  - Unit anchors with concrete numbers from the task brief.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  estimateScholarshipPct,
  scoreFinance,
  matchScholarships,
} from '../src/partners/scholarshipMatcher';
import type { StudentFinance, ProgramFinance } from '../src/partners/scholarshipMatcher';

// --- generators --------------------------------------------------------------

const nonNeg = (max: number) => fc.float({ min: 0, max, noNaN: true });

// A nullable numeric field: sometimes absent (null), sometimes a value.
const optional = (gen: fc.Arbitrary<number>): fc.Arbitrary<number | null> =>
  fc.option(gen, { nil: null });

const studentArb: fc.Arbitrary<StudentFinance> = fc.record({
  budgetPerYearVndM: optionalUndef(nonNeg(2000)),
  gpa: optionalUndef(fc.float({ min: 0, max: 10, noNaN: true })),
  ielts: optionalUndef(fc.float({ min: 0, max: 9, noNaN: true })),
});

function optionalUndef(gen: fc.Arbitrary<number>): fc.Arbitrary<number | undefined> {
  return fc.option(gen, { nil: undefined });
}

let pid = 0;
const programArb: fc.Arbitrary<ProgramFinance> = fc.record({
  tuitionPerYearVndM: optional(nonNeg(1500)),
  livingCostPerYearVndM: optional(nonNeg(800)),
  scholarshipMaxPct: optional(fc.float({ min: 0, max: 100, noNaN: true })),
  minGpa: optional(fc.float({ min: 0, max: 10, noNaN: true })),
  minIelts: optional(fc.float({ min: 0, max: 9, noNaN: true })),
}).map((p) => ({
  id: `prog_${pid++}`,
  name: `Program ${pid}`,
  country: 'Testland',
  ...p,
}));

// --- scoreFinance properties -------------------------------------------------

describe('scholarshipMatcher — scoreFinance properties', () => {
  it('never produces NaN/Infinity in any numeric field', () => {
    fc.assert(
      fc.property(studentArb, programArb, (student, program) => {
        const r = scoreFinance(student, program);
        for (const v of [
          r.totalCostPerYearVndM,
          r.estScholarshipPct,
          r.estScholarshipVndM,
          r.netCostPerYearVndM,
          r.shortfallVndM,
        ]) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('net = max(0, total - scholarship), and net never negative', () => {
    fc.assert(
      fc.property(studentArb, programArb, (student, program) => {
        const r = scoreFinance(student, program);
        const expected = Math.round(Math.max(0, r.totalCostPerYearVndM - r.estScholarshipVndM) * 10) / 10;
        expect(r.netCostPerYearVndM).toBeCloseTo(expected, 6);
        expect(r.netCostPerYearVndM).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it('estScholarshipPct stays within [0, scholarshipMaxPct]', () => {
    // The engine rounds the estimate to 1 decimal (round1) AFTER scaling by a
    // factor in [0,1]. Since the factor never exceeds 1, the true upper bound is
    // round1(maxPct) (rounding can nudge e.g. 2.6904 -> 2.7).
    const round1 = (n: number) => Math.round(n * 10) / 10;
    fc.assert(
      fc.property(studentArb, programArb, (student, program) => {
        const pct = estimateScholarshipPct(student, program);
        const maxPct = Math.max(0, Math.min(100, program.scholarshipMaxPct ?? 0));
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(round1(maxPct) + 1e-9);
        // scoreFinance must report the same estimate
        expect(scoreFinance(student, program).estScholarshipPct).toBe(pct);
      }),
      { numRuns: 300 },
    );
  });

  it('affordable === (budget>0 && net<=budget)', () => {
    fc.assert(
      fc.property(studentArb, programArb, (student, program) => {
        const r = scoreFinance(student, program);
        const budget = student.budgetPerYearVndM ?? 0;
        const expected = budget > 0 ? r.netCostPerYearVndM <= budget : false;
        expect(r.affordable).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});

// --- matchScholarships properties --------------------------------------------

describe('scholarshipMatcher — matchScholarships properties', () => {
  it('ranks affordable before unaffordable, affordable sorted by net asc', () => {
    fc.assert(
      fc.property(
        studentArb,
        fc.array(programArb, { maxLength: 12 }),
        fc.integer({ min: 1, max: 20 }),
        (student, programs, limit) => {
          const out = matchScholarships(student, programs, limit);

          // All affordable entries precede all unaffordable ones.
          let seenUnaffordable = false;
          for (const r of out) {
            if (!r.affordable) seenUnaffordable = true;
            else expect(seenUnaffordable).toBe(false);
          }

          // Affordable block is sorted by net cost ascending.
          const affordable = out.filter((r) => r.affordable);
          for (let i = 1; i < affordable.length; i++) {
            expect(affordable[i - 1].netCostPerYearVndM).toBeLessThanOrEqual(
              affordable[i].netCostPerYearVndM,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('only programs with cost data appear, and result size respects the limit', () => {
    fc.assert(
      fc.property(
        studentArb,
        fc.array(programArb, { maxLength: 12 }),
        fc.integer({ min: 1, max: 20 }),
        (student, programs, limit) => {
          const out = matchScholarships(student, programs, limit);

          const eligible = programs.filter(
            (p) => (p.tuitionPerYearVndM ?? 0) > 0 || (p.livingCostPerYearVndM ?? 0) > 0,
          );
          expect(out.length).toBe(Math.min(eligible.length, limit));

          const eligibleIds = new Set(eligible.map((p) => p.id));
          for (const r of out) {
            // Membership in the engine's raw cost filter is the real invariant.
            expect(eligibleIds.has(r.programId)).toBe(true);
            // Cost is always a non-negative, finite number (round1 can collapse
            // denormal inputs to exactly 0, so this is >= rather than >).
            expect(r.totalCostPerYearVndM).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(r.totalCostPerYearVndM)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// --- unit anchors ------------------------------------------------------------

describe('scholarshipMatcher — unit anchors', () => {
  const student: StudentFinance = { budgetPerYearVndM: 300, gpa: 8.0, ielts: 6.5 };

  const richProgram: ProgramFinance = {
    id: 'p1',
    name: 'Affordable U',
    country: 'Testland',
    tuitionPerYearVndM: 250,
    livingCostPerYearVndM: 100,
    scholarshipMaxPct: 50,
    minGpa: 7,
    minIelts: 6,
  };

  it('budget 300 / GPA 8.0 / IELTS 6.5 vs tuition 250+living 100, maxPct 50: scholarship>0 and net<total', () => {
    const r = scoreFinance(student, richProgram);
    expect(r.totalCostPerYearVndM).toBe(350);
    expect(r.estScholarshipPct).toBeGreaterThan(0);
    expect(r.estScholarshipVndM).toBeGreaterThan(0);
    expect(r.netCostPerYearVndM).toBeLessThan(r.totalCostPerYearVndM);
    // scholarship applies to tuition only and is capped by maxPct
    expect(r.estScholarshipPct).toBeLessThanOrEqual(50);
  });

  it('a program with no cost data is excluded from matches', () => {
    const noCost: ProgramFinance = {
      id: 'p2',
      name: 'No Cost Data',
      country: 'Testland',
      tuitionPerYearVndM: null,
      livingCostPerYearVndM: null,
      scholarshipMaxPct: 80,
      minGpa: 5,
      minIelts: 5,
    };
    const out = matchScholarships(student, [richProgram, noCost], 10);
    const ids = out.map((r) => r.programId);
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
  });

  it('below-threshold GPA contributes 0 to that dimension', () => {
    // IELTS dimension only (minGpa null) → full headroom estimate.
    const ieltsOnly: ProgramFinance = {
      id: 'pi',
      name: 'IELTS only',
      country: 'Testland',
      tuitionPerYearVndM: 200,
      livingCostPerYearVndM: 0,
      scholarshipMaxPct: 100,
      minGpa: null,
      minIelts: 6,
    };
    const ieltsOnlyPct = estimateScholarshipPct({ gpa: 0, ielts: 6.5 }, ieltsOnly);

    // Same program but now also requires a GPA the student misses → GPA dim = 0,
    // averaged with the (unchanged) IELTS dim, so the estimate drops.
    const withGpaGate: ProgramFinance = { ...ieltsOnly, id: 'pg', minGpa: 8 };
    const gatedPct = estimateScholarshipPct({ gpa: 5, ielts: 6.5 }, withGpaGate);

    expect(gatedPct).toBeGreaterThanOrEqual(0);
    expect(gatedPct).toBeLessThan(ieltsOnlyPct);
  });
});
