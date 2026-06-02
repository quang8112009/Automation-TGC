/**
 * Property + unit tests for the Destination_Matcher scoring module
 * (`src/intake/destinationMatcher.ts`).
 *
 * The pure `scoreProgram` / `matchDestinations` logic must never emit NaN,
 * always clamp the fit score to [0, 100], keep `eligible` in lock-step with the
 * presence of blockers, and rank eligible suggestions ahead of ineligible ones
 * (score non-increasing within each group). Hard constraints — closed/inactive
 * programs, age/gender/budget out of range, language below the required level —
 * must surface as blockers, while soft matches (country, industry, language)
 * only add to the score.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  matchDestinations,
  scoreProgram,
  normalizeGender,
  type MatchProfile,
  type ProgramCriteria,
} from '../src/intake/destinationMatcher';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const genderArb = fc.constantFrom('MALE', 'FEMALE', 'Nam', 'Nữ', 'nam', 'nữ', '', 'other', 'ANY');

const profileArb: fc.Arbitrary<MatchProfile> = fc.record({
  age: fc.option(fc.integer({ min: -5, max: 120 }), { nil: undefined }),
  gender: fc.option(genderArb, { nil: undefined }),
  country: fc.option(fc.constantFrom('Nhật Bản', 'Hàn Quốc', 'Đức', 'Úc', ''), { nil: undefined }),
  industry: fc.option(fc.constantFrom('cơ khí', 'điều dưỡng', 'xây dựng', 'IT', ''), {
    nil: undefined,
  }),
  language: fc.option(fc.constantFrom('japanese', 'english', ''), { nil: undefined }),
  languageLevel: fc.option(fc.constantFrom('N5', 'N4', 'N3', 'N2', 'N1', 'IELTS5.5', ''), {
    nil: undefined,
  }),
  budgetVndM: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
});

const programArb: fc.Arbitrary<ProgramCriteria> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  name: fc.string({ maxLength: 12 }),
  country: fc.constantFrom('Nhật Bản', 'Hàn Quốc', 'Đức', 'Úc'),
  minAge: fc.option(fc.integer({ min: 16, max: 40 }), { nil: null }),
  maxAge: fc.option(fc.integer({ min: 16, max: 60 }), { nil: null }),
  gender: fc.option(fc.constantFrom('ANY', 'MALE', 'FEMALE'), { nil: undefined }),
  requiredLanguage: fc.option(fc.constantFrom('japanese', 'english'), { nil: undefined }),
  minLanguageLevel: fc.option(fc.constantFrom('N5', 'N4', 'N3', 'N2', 'IELTS5.5'), {
    nil: undefined,
  }),
  budgetMinVndM: fc.option(fc.integer({ min: 0, max: 300 }), { nil: null }),
  budgetMaxVndM: fc.option(fc.integer({ min: 0, max: 500 }), { nil: null }),
  industries: fc.option(fc.array(fc.constantFrom('cơ khí', 'điều dưỡng', 'IT'), { maxLength: 3 }), {
    nil: undefined,
  }),
  conditions: fc.option(fc.array(fc.string({ maxLength: 6 }), { maxLength: 2 }), { nil: undefined }),
  status: fc.option(fc.constantFrom('OPEN', 'CLOSED', 'PAUSED', ''), { nil: undefined }),
  active: fc.option(fc.boolean(), { nil: undefined }),
});

/**
 * A program guaranteed to fail the availability gate: either `active === false`
 * (with any status), or a truthy, non-"open" status (with active true/undefined).
 */
const blockingAvailabilityArb = fc.oneof(
  fc.record({
    active: fc.constant<false>(false),
    status: fc.option(fc.constantFrom('OPEN', 'CLOSED', ''), { nil: undefined }),
  }),
  fc.record({
    active: fc.option(fc.constant<true>(true), { nil: undefined }),
    status: fc.constantFrom('CLOSED', 'PAUSED', 'closed', 'FULL', 'Đóng'),
  }),
);

const closedProgramArb: fc.Arbitrary<ProgramCriteria> = fc
  .tuple(programArb, blockingAvailabilityArb)
  .map(([program, avail]) => ({ ...program, ...avail }));

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('scoreProgram — properties', () => {
  it('score is a finite number in [0, 100] (never NaN) and eligible === (no blockers)', () => {
    fc.assert(
      fc.property(profileArb, programArb, (profile, program) => {
        const s = scoreProgram(profile, program);
        expect(Number.isNaN(s.score)).toBe(false);
        expect(Number.isFinite(s.score)).toBe(true);
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100);
        expect(s.eligible).toBe(s.blockers.length === 0);
      }),
      { numRuns: 300 },
    );
  });

  it('an inactive (active:false) or non-OPEN program is never eligible', () => {
    fc.assert(
      fc.property(profileArb, closedProgramArb, (profile, program) => {
        const s = scoreProgram(profile, program);
        expect(s.eligible).toBe(false);
        expect(s.blockers.length).toBeGreaterThan(0);
        expect(s.blockers).toContain('Chương trình hiện không mở tuyển');
      }),
      { numRuns: 300 },
    );
  });
});

describe('matchDestinations — properties', () => {
  it('every suggestion has a finite score in [0, 100] with eligible === (no blockers)', () => {
    fc.assert(
      fc.property(profileArb, fc.array(programArb, { maxLength: 8 }), (profile, programs) => {
        const results = matchDestinations(profile, programs, 100);
        for (const s of results) {
          expect(Number.isNaN(s.score)).toBe(false);
          expect(Number.isFinite(s.score)).toBe(true);
          expect(s.score).toBeGreaterThanOrEqual(0);
          expect(s.score).toBeLessThanOrEqual(100);
          expect(s.eligible).toBe(s.blockers.length === 0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('all eligible suggestions come before any ineligible one; score is non-increasing within each group', () => {
    fc.assert(
      fc.property(profileArb, fc.array(programArb, { maxLength: 8 }), (profile, programs) => {
        const results = matchDestinations(profile, programs, 100);

        // Once an ineligible suggestion appears, no eligible one may follow.
        let seenIneligible = false;
        for (const s of results) {
          if (!s.eligible) {
            seenIneligible = true;
          } else {
            expect(seenIneligible).toBe(false);
          }
        }

        // Within a group (same eligibility), score must be non-increasing.
        for (let i = 1; i < results.length; i++) {
          const prev = results[i - 1];
          const cur = results[i];
          if (prev.eligible === cur.eligible) {
            expect(cur.score).toBeLessThanOrEqual(prev.score);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit examples
// ---------------------------------------------------------------------------

describe('scoreProgram — age constraint', () => {
  const program: ProgramCriteria = {
    id: 'p-age',
    name: 'JP Mechanical',
    country: 'Nhật Bản',
    minAge: 18,
    maxAge: 30,
  };

  it('a candidate aged 16 (below 18..30) is blocked with an age blocker', () => {
    const s = scoreProgram({ age: 16 }, program);
    expect(s.eligible).toBe(false);
    expect(s.blockers.some((b) => /tuổi/i.test(b))).toBe(true);
  });

  it('a candidate aged 25 (within 18..30) contributes a matched age entry', () => {
    const s = scoreProgram({ age: 25 }, program);
    expect(s.eligible).toBe(true);
    expect(s.matched).toContain('Phù hợp độ tuổi');
  });
});

describe('scoreProgram — gender constraint', () => {
  it("program gender FEMALE blocks a 'Nam' candidate", () => {
    const program: ProgramCriteria = { id: 'g1', name: 'Care', country: 'Nhật Bản', gender: 'FEMALE' };
    const s = scoreProgram({ gender: 'Nam' }, program);
    expect(s.eligible).toBe(false);
    expect(s.blockers.some((b) => /giới tính/i.test(b))).toBe(true);
  });

  it("program gender FEMALE blocks a 'MALE' candidate", () => {
    const program: ProgramCriteria = { id: 'g2', name: 'Care', country: 'Nhật Bản', gender: 'FEMALE' };
    const s = scoreProgram({ gender: 'MALE' }, program);
    expect(s.eligible).toBe(false);
    expect(s.blockers.some((b) => /giới tính/i.test(b))).toBe(true);
  });

  it("program gender 'ANY' produces no gender blocker", () => {
    const program: ProgramCriteria = { id: 'g3', name: 'Open', country: 'Nhật Bản', gender: 'ANY' };
    const s = scoreProgram({ gender: 'MALE' }, program);
    expect(s.blockers.some((b) => /giới tính/i.test(b))).toBe(false);
  });
});

describe('scoreProgram — country & relative ranking', () => {
  it('a country match adds to the score and records a matched entry', () => {
    const program: ProgramCriteria = { id: 'c1', name: 'JP', country: 'Nhật Bản' };
    const s = scoreProgram({ country: 'Nhật Bản' }, program);
    expect(s.score).toBeGreaterThan(0);
    expect(s.matched.some((m) => /thị trường/i.test(m))).toBe(true);
  });

  it('a fully-matching eligible program scores higher than a near-miss', () => {
    const profile: MatchProfile = {
      age: 25,
      gender: 'Nam',
      country: 'Nhật Bản',
      industry: 'cơ khí',
      language: 'japanese',
      languageLevel: 'N3',
      budgetVndM: 150,
    };
    const fullProgram: ProgramCriteria = {
      id: 'full',
      name: 'Full match',
      country: 'Nhật Bản',
      minAge: 18,
      maxAge: 35,
      gender: 'MALE',
      requiredLanguage: 'japanese',
      minLanguageLevel: 'N4',
      budgetMinVndM: 100,
      budgetMaxVndM: 200,
      industries: ['cơ khí'],
      status: 'OPEN',
      active: true,
    };
    const nearProgram: ProgramCriteria = {
      id: 'near',
      name: 'Near miss',
      country: 'Nhật Bản',
      gender: 'ANY',
      status: 'OPEN',
      active: true,
    };

    const full = scoreProgram(profile, fullProgram);
    const near = scoreProgram(profile, nearProgram);

    expect(full.eligible).toBe(true);
    expect(near.eligible).toBe(true);
    expect(full.score).toBeGreaterThan(near.score);

    // And matchDestinations ranks the fuller match first.
    const ranked = matchDestinations(profile, [nearProgram, fullProgram]);
    expect(ranked[0].programId).toBe('full');
  });
});

describe('normalizeGender', () => {
  it("maps 'Nam' -> 'MALE', 'Nữ' -> 'FEMALE', '' -> ''", () => {
    expect(normalizeGender('Nam')).toBe('MALE');
    expect(normalizeGender('Nữ')).toBe('FEMALE');
    expect(normalizeGender('')).toBe('');
  });
});

describe('scoreProgram — budget constraint', () => {
  it('a candidate budget below the program minimum is blocked', () => {
    const program: ProgramCriteria = {
      id: 'b1',
      name: 'Pricey',
      country: 'Nhật Bản',
      budgetMinVndM: 100,
    };
    const s = scoreProgram({ budgetVndM: 50 }, program);
    expect(s.eligible).toBe(false);
    expect(s.blockers.some((b) => /ngân sách/i.test(b))).toBe(true);
  });
});
