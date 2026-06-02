/**
 * Property + unit tests for the Visa_Catalog smart-checklist generator and the
 * Logistics_Planner suggestion engine (both pure / framework-free).
 *
 * Invariants under test:
 *  - `checklistFor` is total (never throws), case-insensitive, always returns
 *    at least the base tasks, has unique `code`s, and is sorted by `leadDays`
 *    descending.
 *  - Country-specific tasks are layered on top of the base set (OSHC for AU,
 *    I20 for USA, IHS/CAS for the UK).
 *  - `withDeadlines` yields null due dates for a null intake, and otherwise a
 *    due date exactly `leadDays` days before the intake (and strictly before it).
 *  - `suggestLogistics` is total and country-aware (OSHC/IHS/TRAVEL).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  checklistFor,
  hasCountryTemplate,
  withDeadlines,
  normalizeCountry,
  type VisaTaskTemplate,
} from '../src/visa/visaCatalog';
import {
  suggestLogistics,
  type InsuranceType,
} from '../src/visa/logisticsPlanner';

const DAY_MS = 86_400_000;
const KNOWN_COUNTRIES = ['AUSTRALIA', 'USA', 'CANADA', 'UK', 'JAPAN'] as const;

describe('checklistFor — known countries (examples)', () => {
  it('returns a non-empty list for every known country', () => {
    for (const country of KNOWN_COUNTRIES) {
      expect(checklistFor(country).length).toBeGreaterThan(0);
      expect(hasCountryTemplate(country)).toBe(true);
    }
  });

  it('is case-insensitive (australia === AUSTRALIA)', () => {
    expect(checklistFor('australia')).toEqual(checklistFor('AUSTRALIA'));
    expect(checklistFor('  Usa  ')).toEqual(checklistFor('USA'));
    expect(normalizeCountry('  australia ')).toBe('AUSTRALIA');
  });

  it('AUSTRALIA includes an INSURANCE task with code OSHC', () => {
    const oshc = checklistFor('AUSTRALIA').find((t) => t.code === 'OSHC');
    expect(oshc).toBeDefined();
    expect(oshc?.category).toBe('INSURANCE');
  });

  it('USA includes the I20 task', () => {
    expect(checklistFor('USA').some((t) => t.code === 'I20')).toBe(true);
  });

  it('UK includes IHS or CAS', () => {
    const codes = checklistFor('UK').map((t) => t.code);
    expect(codes.includes('IHS') || codes.includes('CAS')).toBe(true);
  });
});

describe('checklistFor — properties (arbitrary country strings)', () => {
  it('never throws and always returns at least the base tasks (length >= 1)', () => {
    fc.assert(
      fc.property(fc.string(), (country) => {
        const list = checklistFor(country);
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('every task code is unique within the returned list', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...KNOWN_COUNTRIES)),
        (country) => {
          const codes = checklistFor(country).map((t) => t.code);
          expect(new Set(codes).size).toBe(codes.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('list is sorted by leadDays descending (non-increasing)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...KNOWN_COUNTRIES)),
        (country) => {
          const list = checklistFor(country);
          for (let i = 1; i < list.length; i++) {
            expect(list[i - 1].leadDays).toBeGreaterThanOrEqual(list[i].leadDays);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('withDeadlines — properties', () => {
  it('a null target intake yields a null dueAt for every task', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...KNOWN_COUNTRIES)),
        (country) => {
          const dated = withDeadlines(checklistFor(country), null);
          expect(dated.every((t) => t.dueAt === null)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a real target intake yields dueAt === target - leadDays*DAY_MS, strictly before target', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...KNOWN_COUNTRIES)),
        // arbitrary future intake date built from a day offset (always valid)
        fc.integer({ min: 1, max: 3650 }),
        (country, daysAhead) => {
          const target = new Date(Date.now() + daysAhead * DAY_MS);
          const templates: VisaTaskTemplate[] = checklistFor(country);
          const dated = withDeadlines(templates, target);

          expect(dated.length).toBe(templates.length);
          for (let i = 0; i < dated.length; i++) {
            const due = dated[i].dueAt;
            expect(due).not.toBeNull();
            // exact arithmetic: leadDays days before the intake
            expect(due!.getTime()).toBe(target.getTime() - templates[i].leadDays * DAY_MS);
            // catalog leadDays are all > 0, so the deadline is strictly before intake
            expect(due!.getTime()).toBeLessThan(target.getTime());
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('suggestLogistics — examples', () => {
  it('AUSTRALIA -> OSHC, UK -> IHS, unknown -> TRAVEL', () => {
    expect(suggestLogistics('AUSTRALIA').insuranceType).toBe<InsuranceType>('OSHC');
    expect(suggestLogistics('UK').insuranceType).toBe<InsuranceType>('IHS');
    expect(suggestLogistics('Atlantis-Nowhere').insuranceType).toBe<InsuranceType>('TRAVEL');
  });
});

describe('suggestLogistics — properties', () => {
  it('never throws; returns a non-empty checklist and a boolean recommendPickup', () => {
    fc.assert(
      fc.property(fc.string(), (country) => {
        const plan = suggestLogistics(country);
        expect(Array.isArray(plan.checklist)).toBe(true);
        expect(plan.checklist.length).toBeGreaterThan(0);
        expect(typeof plan.recommendPickup).toBe('boolean');
        expect(Array.isArray(plan.notes)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
