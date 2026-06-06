/**
 * Review_Mode tests — Task 5.4 (deepseek-v4-model-migration).
 *
 * The DeepSeek text-provider migration must NOT weaken REVIEW MODE: every AI
 * output still has to pass through the existing guarded state machine before it
 * is treated as official/approved, regardless of which provider generated it,
 * and no output (not even a "simple" one, not even an "urgent" one) may bypass
 * human approval. (Validates Req 5.3, 5.4, 5.5)
 *
 * The migration changed only the AI text CLIENT/CONFIG behind the seam — it did
 * not touch `essayTransition`/`ESSAY_TRANSITIONS`. These tests pin the guard so
 * a future change that tried to add an approval bypass would fail here.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  essayTransition,
  ESSAY_TRANSITIONS,
} from '../src/essays/essayStateMachine';
import type { EssayStatus } from '../src/essays/essayStateMachine';

const ALL_STATUSES: EssayStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ARCHIVED'];

describe('Review_Mode preserved after the DeepSeek migration (Req 5.3, 5.4, 5.5)', () => {
  it('a freshly generated AI draft starts at DRAFT and cannot jump straight to APPROVED', () => {
    // No output bypasses review: DRAFT → APPROVED is NOT an allowed transition;
    // approval must go through IN_REVIEW (human approval). (Req 5.3, 5.4)
    expect(essayTransition('DRAFT', 'APPROVED')).toEqual({ ok: false, status: 409 });
    expect(essayTransition('DRAFT', 'IN_REVIEW')).toEqual({ ok: true, status: 'IN_REVIEW' });
    expect(essayTransition('IN_REVIEW', 'APPROVED')).toEqual({ ok: true, status: 'APPROVED' });
  });

  it('APPROVED and ARCHIVED are terminal — no transition out of them', () => {
    for (const target of ALL_STATUSES) {
      expect(essayTransition('APPROVED', target).ok).toBe(false);
      expect(essayTransition('ARCHIVED', target).ok).toBe(false);
    }
  });

  it('the only path to APPROVED is DRAFT → IN_REVIEW → APPROVED (no urgency bypass)', () => {
    // There is exactly one transition whose target is APPROVED, and its source
    // is IN_REVIEW — so reaching APPROVED ALWAYS requires the human-review step.
    // No "urgent" shortcut exists in the transition table. (Req 5.5)
    const toApproved = ESSAY_TRANSITIONS.filter(([, b]) => b === 'APPROVED');
    expect(toApproved).toEqual([['IN_REVIEW', 'APPROVED']]);
  });

  it('property: any transition into APPROVED is rejected unless the source is IN_REVIEW', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_STATUSES), (from) => {
        const res = essayTransition(from, 'APPROVED');
        if (from === 'IN_REVIEW') {
          expect(res).toEqual({ ok: true, status: 'APPROVED' });
        } else {
          expect(res).toEqual({ ok: false, status: 409 });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('illegal transitions return 409 and never mutate to the target', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (from, to) => {
          const allowed = ESSAY_TRANSITIONS.some(([a, b]) => a === from && b === to);
          const res = essayTransition(from, to);
          if (allowed) {
            expect(res).toEqual({ ok: true, status: to });
          } else {
            expect(res).toEqual({ ok: false, status: 409 });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
