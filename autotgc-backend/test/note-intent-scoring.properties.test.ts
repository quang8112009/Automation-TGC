/**
 * Property + unit tests for Note_Intent_Scoring (proposal 3.3).
 *
 * The pure `scoreNotes` heuristic must: never produce NaN, always clamp score
 * to [0,100], treat empty/whitespace notes as insufficient, and ONLY ever
 * suggest a status that is a legal `leadTransition` from the current status.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  scoreNotes,
  POSITIVE_KEYWORDS,
  NEGATIVE_KEYWORDS,
} from '../src/leads/noteIntentScoring';
import { leadTransition, LEAD_STATUSES } from '../src/leads/statusMachine';
import type { LeadStatus } from '../src/leads/statusMachine';

const statusArb = fc.constantFrom<LeadStatus>(...(LEAD_STATUSES as LeadStatus[]));

describe('scoreNotes — properties', () => {
  it('score is always a finite number within [0, 100]', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), statusArb, (notes, status) => {
        const { score } = scoreNotes(notes, status);
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }),
      { numRuns: 300 },
    );
  });

  it('empty / whitespace-only notes => insufficient, COLD, no suggestion', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('', '   ', '\n', '\t')),
        statusArb,
        (notes, status) => {
          const signal = scoreNotes(notes, status);
          expect(signal.insufficient).toBe(true);
          expect(signal.score).toBe(0);
          expect(signal.label).toBe('COLD');
          expect(signal.suggestedStatus).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('suggestedStatus is ALWAYS null or a legal transition from currentStatus', () => {
    const wordArb = fc.constantFrom(
      ...POSITIVE_KEYWORDS,
      ...NEGATIVE_KEYWORDS,
      'xin chào',
      'ghi chú',
      'random',
    );
    fc.assert(
      fc.property(fc.array(wordArb, { maxLength: 8 }), statusArb, (notes, status) => {
        const { suggestedStatus } = scoreNotes(notes, status);
        if (suggestedStatus !== null) {
          expect(leadTransition(status, suggestedStatus).ok).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('adding a positive keyword never decreases the score', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...POSITIVE_KEYWORDS, 'ghi chú thường'), { maxLength: 5 }),
        statusArb,
        (notes, status) => {
          const base = scoreNotes(notes, status).score;
          const withPositive = scoreNotes([...notes, 'quan tâm'], status).score;
          expect(withPositive).toBeGreaterThanOrEqual(base);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('scoreNotes — concrete examples', () => {
  it('strong positive notes from CONSULTING => HOT with a legal advance', () => {
    const signal = scoreNotes(
      ['Ứng viên đồng ý, muốn đi, đã đặt cọc và hẹn phỏng vấn tuần sau'],
      'NEW',
    );
    expect(signal.label).toBe('HOT');
    expect(signal.insufficient).toBe(false);
    // From NEW the only legal forward is CONTACTED.
    expect(signal.suggestedStatus).toBe('CONTACTED');
  });

  it('rejection notes => AT_RISK and suggests LOST when legal', () => {
    const signal = scoreNotes(['Khách từ chối, không quan tâm, thấy chi phí cao'], 'CONTACTED');
    expect(signal.label).toBe('AT_RISK');
    expect(signal.suggestedStatus).toBe('LOST');
  });

  it('neutral note => not insufficient but no strong signal', () => {
    const signal = scoreNotes(['Đã gọi, để lại lời nhắn'], 'NEW');
    expect(signal.insufficient).toBe(false);
    expect(['COLD', 'WARM']).toContain(signal.label);
  });
});
