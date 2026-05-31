import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { contentTransition, CONTENT_TRANSITIONS, ContentStatus } from '../src/content/stateMachine';
import { leadTransition, LEAD_TRANSITIONS, LeadStatus } from '../src/leads/statusMachine';
import { insightTransition, INSIGHT_TRANSITIONS, InsightStatus } from '../src/analytics/insightStateMachine';

const CONTENT: ContentStatus[] = ['DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'FAILED'];
const LEAD: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'];
const INSIGHT: InsightStatus[] = ['NEW', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'];

describe('state machines', () => {
  // Feature: content-pipeline, Property 12: Content state-machine transition closure
  it('content: succeeds iff pair is allowed, else 409', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CONTENT), fc.constantFrom(...CONTENT), (a, b) => {
        const r = contentTransition(a, b);
        const allowed = CONTENT_TRANSITIONS.some(([x, y]) => x === a && y === b);
        expect(r.ok).toBe(allowed);
        if (!r.ok) expect(r.status).toBe(409);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: lead-management-dashboard, Property 12: Lead status transition closure
  it('lead: succeeds iff pair is allowed, else 409; terminals never source', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEAD), fc.constantFrom(...LEAD), (a, b) => {
        const r = leadTransition(a, b);
        const allowed = LEAD_TRANSITIONS.some(([x, y]) => x === a && y === b);
        expect(r.ok).toBe(allowed);
        if (a === 'CONVERTED' || a === 'LOST') expect(r.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 18: Insight lifecycle transition closure
  it('insight: succeeds iff pair is allowed; terminals never source', () => {
    fc.assert(
      fc.property(fc.constantFrom(...INSIGHT), fc.constantFrom(...INSIGHT), (a, b) => {
        const r = insightTransition(a, b);
        const allowed = INSIGHT_TRANSITIONS.some(([x, y]) => x === a && y === b);
        expect(r.ok).toBe(allowed);
        if (a === 'APPROVED' || a === 'REJECTED') expect(r.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
