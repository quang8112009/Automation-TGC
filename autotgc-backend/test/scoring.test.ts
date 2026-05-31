import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeRates, labelFor, DEFAULT_SCORING_CONFIG, Platform } from '../src/analytics/scoring';

const PLATFORMS: Platform[] = ['facebook', 'tiktok', 'website'];

describe('analytics-feedback-loop scoring', () => {
  // Feature: analytics-feedback-loop, Property 8: divide-by-zero -> 0 + INSUFFICIENT_DATA
  it('Property 8: zero denominator yields 0 rate (never NaN/Infinity) and insufficient', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PLATFORMS),
        fc.record({
          views: fc.integer({ min: 0, max: 100000 }),
          reach: fc.integer({ min: 0, max: 100000 }),
          leads: fc.integer({ min: 0, max: 1000 }),
          likes: fc.integer({ min: 0, max: 1000 }),
          comments: fc.integer({ min: 0, max: 1000 }),
          shares: fc.integer({ min: 0, max: 1000 }),
          follows: fc.integer({ min: 0, max: 1000 }),
          clickThrough: fc.integer({ min: 0, max: 1000 }),
        }),
        (platform, m) => {
          const { rates, insufficient } = computeRates(platform, m);
          for (const v of [rates.conversionRate, rates.engagementRate, rates.ctaClickRate]) {
            expect(Number.isFinite(v)).toBe(true);
          }
          if (m.views === 0) {
            expect(rates.conversionRate).toBe(0);
            expect(rates.ctaClickRate).toBe(0);
            expect(insufficient).toBe(true);
          }
          if (platform === 'tiktok') {
            expect(rates.followRate).toBeNull();
          } else if (m.reach === 0) {
            expect(rates.engagementRate).toBe(0);
            expect(rates.followRate).toBe(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 9: label threshold mapping
  it('Property 9: label maps conversion vs thresholds; insufficient never a tier', () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 100, noNaN: true }), fc.boolean(), (cr, insufficient) => {
        const label = labelFor(cr, insufficient, DEFAULT_SCORING_CONFIG);
        if (insufficient) {
          expect(label).toBe('INSUFFICIENT_DATA');
        } else if (cr >= 5) {
          expect(label).toBe('HIGH_PERFORMER');
        } else if (cr >= 2) {
          expect(label).toBe('AVERAGE_PERFORMER');
        } else {
          expect(label).toBe('LOW_PERFORMER');
        }
      }),
      { numRuns: 300 },
    );
  });
});
