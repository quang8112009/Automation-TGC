import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { CollectionService } from '../src/analytics/collectionService';
import type { TokenGate } from '../src/analytics/collectionService';
import {
  eligibleTopics,
  pickInsightType,
} from '../src/analytics/feedbackEngine';
import type { PerformanceRow } from '../src/analytics/feedbackEngine';
import { DEFAULT_FEEDBACK_CONFIG } from '../src/analytics/types';
import {
  INSIGHT_TRANSITIONS,
  insightTransition,
} from '../src/analytics/insightStateMachine';
import type { InsightStatus } from '../src/analytics/insightStateMachine';
import { AiContextReadModel } from '../src/strategy/aiContextReadModel';
import type { Platform } from '../src/analytics/scoring';

// A CollectionService instance is enough to exercise the pure shapeMetrics; the
// I/O collaborators are never touched by that method, so minimal stubs suffice.
const noopTokenGate: TokenGate = {
  isValid: async () => true,
  refresh: async () => undefined,
};
function makeCollectionService(): CollectionService {
  // The Prisma/registry/alerts deps are unused by shapeMetrics; cast minimal stubs.
  return new CollectionService(
    {} as never,
    {} as never,
    noopTokenGate,
    { raise: async () => undefined },
  );
}

const PLATFORMS: Platform[] = ['facebook', 'tiktok', 'website'];
const ALL_STATUSES: InsightStatus[] = ['NEW', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'];

describe('analytics-feedback-loop', () => {
  // Feature: analytics-feedback-loop, Property 1:
  // shapeMetrics forces TikTok reach/follows to null, and any metric whose
  // source key is absent is null (never coerced to 0).
  it('Property 1: shapeMetrics — TikTok reach/follows null + missing -> null (never 0)', () => {
    const svc = makeCollectionService();
    fc.assert(
      fc.property(
        fc.constantFrom(...PLATFORMS),
        // A sparse raw payload: each metric may be present (number) or absent.
        fc.record(
          {
            views: fc.integer({ min: 0, max: 100000 }),
            likes: fc.integer({ min: 0, max: 100000 }),
            shares: fc.integer({ min: 0, max: 100000 }),
            comments: fc.integer({ min: 0, max: 100000 }),
            follows: fc.integer({ min: 0, max: 100000 }),
            leads: fc.integer({ min: 0, max: 100000 }),
            clickThrough: fc.integer({ min: 0, max: 100000 }),
            reach: fc.integer({ min: 0, max: 100000 }),
          },
          { requiredKeys: [] },
        ),
        (platform, raw) => {
          const shaped = svc.shapeMetrics(platform, raw);

          if (platform === 'tiktok') {
            // Unavailable_Metrics for TikTok are always null, even if a value was
            // present in the raw payload.
            expect(shaped.reach).toBeNull();
            expect(shaped.follows).toBeNull();
          }

          // Any metric key absent from the raw payload is null, never 0.
          const rawKeys = new Set(Object.keys(raw));
          if (!rawKeys.has('views')) expect(shaped.views).toBeNull();
          if (!rawKeys.has('leads')) expect(shaped.leads).toBeNull();
          if (!rawKeys.has('comments')) expect(shaped.comments).toBeNull();

          // A present metric is carried through as its numeric value (except the
          // TikTok-forced-null pair handled above).
          if (rawKeys.has('views') && typeof raw.views === 'number') {
            expect(shaped.views).toBe(raw.views);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  // Feature: analytics-feedback-loop, Property 2:
  // eligibleTopics gates on MIN_SAMPLE: a topic is returned iff its count of
  // non-INSUFFICIENT_DATA records is >= minSample.
  it('Property 2: eligibleTopics — MIN_SAMPLE gating over non-insufficient records', () => {
    const rowFor = (topic: string, insufficient: boolean): PerformanceRow => ({
      postId: 'p',
      domainCategory: 'd',
      contentTopic: topic,
      personaId: 'persona',
      toneOfVoice: 'friendly',
      objective: 'Lead',
      platform: 'facebook',
      postTimeSlot: 'morning',
      ctaType: 'link',
      conversionRate: 1,
      engagementRate: 1,
      ctaClickRate: 1,
      followRate: 1,
      performanceLabel: insufficient ? 'INSUFFICIENT_DATA' : 'AVERAGE_PERFORMER',
    });

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            topic: fc.constantFrom('a', 'b', 'c'),
            insufficient: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        fc.integer({ min: 1, max: 8 }),
        (specs, minSample) => {
          const rows = specs.map((s) => rowFor(s.topic, s.insufficient));
          const result = eligibleTopics(rows, minSample);

          // Reference count of usable (non-insufficient) records per topic.
          const counts = new Map<string, number>();
          for (const s of specs) {
            if (s.insufficient) continue;
            counts.set(s.topic, (counts.get(s.topic) ?? 0) + 1);
          }

          for (const topic of ['a', 'b', 'c']) {
            const usable = counts.get(topic) ?? 0;
            const present = result.includes(topic);
            expect(present).toBe(usable >= minSample);
          }
          // No INSUFFICIENT_DATA-only topic ever appears.
          expect(new Set(result).size).toBe(result.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 3:
  // The insight lifecycle is closed under insightTransition: a transition
  // succeeds iff (current,target) is in INSIGHT_TRANSITIONS; otherwise 409 and
  // the status is unchanged. APPROVED/REJECTED are terminal (no outgoing edges).
  it('Property 3: insight lifecycle transition closure (reuse INSIGHT_TRANSITIONS)', () => {
    const allowed = new Set(INSIGHT_TRANSITIONS.map(([a, b]) => `${a}->${b}`));

    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (current, target) => {
          const result = insightTransition(current, target);
          const isAllowed = allowed.has(`${current}->${target}`);

          if (isAllowed) {
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.status).toBe(target);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.status).toBe(409);
          }

          // Terminal states never transition anywhere.
          if (current === 'APPROVED' || current === 'REJECTED') {
            expect(result.ok).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 4:
  // pickInsightType threshold mapping: >= HIGH -> TOPIC_FREQUENCY_ADJUSTMENT,
  // < MID -> LOW_PERFORMER_ALERT, otherwise null (the AVERAGE band).
  it('Property 4: pickInsightType thresholds', () => {
    const cfg = DEFAULT_FEEDBACK_CONFIG;
    fc.assert(
      fc.property(fc.float({ min: 0, max: 100, noNaN: true }), (avg) => {
        const type = pickInsightType(avg, cfg);
        if (avg >= cfg.highThreshold) {
          expect(type).toBe('TOPIC_FREQUENCY_ADJUSTMENT');
        } else if (avg < cfg.midThreshold) {
          expect(type).toBe('LOW_PERFORMER_ALERT');
        } else {
          expect(type).toBeNull();
        }
      }),
      { numRuns: 400 },
    );
  });

  // Feature: analytics-feedback-loop, Property 5:
  // ai-context cold-start: when no AiPromptContext row exists, the read model
  // returns the EMPTY context (all arrays empty, lastUpdated null) and never
  // throws — for any (absent) lookup.
  it('Property 5: ai-context cold-start returns empty (never throws)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        // Prisma stub whose findFirst always resolves to null (cold start).
        const prismaStub = {
          aiPromptContext: { findFirst: async () => null },
        };
        const model = new AiContextReadModel(prismaStub as never);
        const ctx = await model.get();

        expect(ctx.contextVersion).toBe('');
        expect(ctx.lastUpdatedFromAnalytics).toBeNull();
        expect(ctx.topPerformingTopics).toEqual([]);
        expect(ctx.bestCtaPatterns).toEqual([]);
        expect(ctx.avoidTopics).toEqual([]);
        expect(ctx.optimalContentLength).toEqual({});
        expect(ctx.toneRecommendations).toEqual({});
        expect(ctx.optimalSchedules).toEqual({});
      }),
      { numRuns: 25 },
    );
  });
});
