import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computeRates, labelFor, DEFAULT_SCORING_CONFIG } from '../src/analytics/scoring';
import type { Platform } from '../src/analytics/scoring';
import { isRetained, retentionCutoff } from '../src/analytics/retention';
import { aggregate, resolveConflicts, FeedbackEngine } from '../src/analytics/feedbackEngine';
import type { PerformanceRow, GeneratedInsight } from '../src/analytics/feedbackEngine';
import { DEFAULT_FEEDBACK_CONFIG } from '../src/analytics/types';
import type { ContentFeatures, AnalysisPeriod } from '../src/analytics/types';
import {
  routeInsight,
  AUTO_APPLY_MAX_FREQUENCY_PCT,
  InsightService,
} from '../src/analytics/insightService';
import type { StrategyProcessor } from '../src/analytics/insightService';
import type { InsightStatus } from '../src/analytics/insightStateMachine';
import { ScoringService } from '../src/analytics/scoringService';
import { CollectionService } from '../src/analytics/collectionService';
import type { TokenGate } from '../src/analytics/collectionService';
import { StrategyUpdateProcessor } from '../src/strategy/strategyUpdateProcessor';
import { AuditLog } from '../src/analytics/auditLog';
import { InMemoryAlertDispatcher } from '../src/infra/alerts';
import { ValidationError, ForbiddenError } from '../src/infra/errors';
import { authorize } from '../src/auth/rbac';
import type { Action, Module } from '../src/auth/rbac';
import { JwtService } from '../src/auth/jwt';
import { ServiceAccountService } from '../src/auth/serviceAccountService';

const PLATFORMS: Platform[] = ['facebook', 'tiktok', 'website'];
const TIME_SLOTS = ['morning', 'afternoon', 'evening', 'night'] as const;
const LABELS = ['HIGH_PERFORMER', 'AVERAGE_PERFORMER', 'LOW_PERFORMER', 'INSUFFICIENT_DATA'] as const;

const noopTokenGate: TokenGate = {
  isValid: async () => true,
  refresh: async () => undefined,
};

/** Build a full PerformanceRow with overridable fields (used by aggregation tests). */
function perfRow(over: Partial<PerformanceRow>): PerformanceRow {
  return {
    postId: 'p',
    domainCategory: 'd',
    contentTopic: 't',
    personaId: 'persona',
    toneOfVoice: 'friendly',
    objective: 'Lead',
    platform: 'facebook',
    postTimeSlot: 'morning',
    ctaType: 'link',
    conversionRate: 0,
    engagementRate: 0,
    ctaClickRate: 0,
    followRate: 0,
    performanceLabel: 'AVERAGE_PERFORMER',
    ...over,
  };
}

describe('analytics-feedback-loop properties', () => {
  // Feature: analytics-feedback-loop, Property 1: Metrics match only their originating post
  it('Property 1: matchToPost resolves a PUBLISHED post iff one has the queried External_Post_Id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            ext: fc.constantFrom('e1', 'e2', 'e3', 'e4'),
            status: fc.constantFrom('PUBLISHED', 'DRAFT', 'SCHEDULED'),
          }),
          { maxLength: 12 },
        ),
        fc.constantFrom('e1', 'e2', 'e3', 'e4', 'missing', ''),
        async (specs, query) => {
          const posts = specs.map((s, i) => ({
            id: `post-${i}`,
            platform: 'facebook',
            externalPostId: s.ext,
            status: s.status,
          }));

          const prisma = {
            scheduledPost: {
              findFirst: async (args: {
                where: { externalPostId: string; status: string };
              }): Promise<{ id: string; platform: string } | null> => {
                const hit = posts.find(
                  (p) =>
                    p.externalPostId === args.where.externalPostId &&
                    p.status === args.where.status,
                );
                return hit ? { id: hit.id, platform: hit.platform } : null;
              },
            },
          };

          const svc = new CollectionService(
            prisma as never,
            {} as never,
            noopTokenGate,
            new InMemoryAlertDispatcher(),
          );

          const result = await svc.matchToPost(query);

          // Reference: first PUBLISHED post whose external id equals the (non-empty) query.
          const expected =
            query === '' ? undefined : posts.find((p) => p.externalPostId === query && p.status === 'PUBLISHED');

          if (expected) {
            expect(result).not.toBeNull();
            // The match references exactly its originating post — never another id.
            expect(result?.id).toBe(expected.id);
          } else {
            // No match / blank id -> no Analytics_Record could be created (Req 2.3).
            expect(result).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 4: Aggregation excludes unavailable and insufficient data
  it('Property 4: aggregate excludes INSUFFICIENT_DATA and equals the value over the kept subset', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            topic: fc.constantFrom('a', 'b', 'c'),
            insufficient: fc.boolean(),
            conv: fc.float({ min: 0, max: 100, noNaN: true }),
          }),
          { maxLength: 40 },
        ),
        fc.constantFrom('a', 'b', 'c'),
        fc.float({ min: 0, max: 100, noNaN: true }),
        (specs, extraTopic, extraConv) => {
          const rows = specs.map((s) =>
            perfRow({
              contentTopic: s.topic,
              conversionRate: s.conv,
              performanceLabel: s.insufficient ? 'INSUFFICIENT_DATA' : 'AVERAGE_PERFORMER',
            }),
          );

          const groups = aggregate(rows, 'content_topic');

          // Total over all groups equals the count of non-insufficient rows.
          const usable = specs.filter((s) => !s.insufficient);
          const total = groups.reduce((acc, g) => acc + g.count, 0);
          expect(total).toBe(usable.length);

          // Per-group count and average match the kept (non-insufficient) subset.
          for (const g of groups) {
            const kept = usable.filter((s) => s.topic === g.key);
            expect(g.count).toBe(kept.length);
            const refAvg = kept.reduce((a, s) => a + s.conv, 0) / kept.length;
            expect(g.avgConversionRate).toBeCloseTo(refAvg, 9);
          }

          // Adding an INSUFFICIENT_DATA member leaves the aggregate unchanged.
          const withExtra = aggregate(
            [...rows, perfRow({ contentTopic: extraTopic, conversionRate: extraConv, performanceLabel: 'INSUFFICIENT_DATA' })],
            'content_topic',
          );
          expect(withExtra).toEqual(groups);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 5: Collection failure isolates the platform and keeps last data
  it('Property 5: a failing platform persists nothing, alerts, keeps prior data; others still persist', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Platform>('facebook', 'tiktok', 'website'), { maxLength: 12 }),
        async (platforms) => {
          const FAIL: Platform = 'facebook';
          // Pre-seed one record for the failing platform to assert it is retained.
          const created: Array<{ platform: string; publishedPostId: string }> = [
            { platform: FAIL, publishedPostId: 'seed' },
          ];
          const initialFailCount = created.filter((r) => r.platform === FAIL).length;

          const okAdapter = {
            collectAnalytics: async (): Promise<{ metrics: Record<string, number | null>; raw: unknown }> => ({
              metrics: { views: 10, leads: 1, reach: 5, likes: 1, comments: 1, shares: 1, clickThrough: 1, follows: 1 },
              raw: {},
            }),
          };
          const failingAdapter = {
            collectAnalytics: async (): Promise<never> => {
              throw new Error('platform request failed');
            },
          };

          const registry = {
            get: (adapterId: string) => (adapterId === 'facebook' ? failingAdapter : okAdapter),
          };

          const prisma = {
            scheduledPost: {
              findMany: async () =>
                platforms.map((p, i) => ({
                  id: `post-${i}`,
                  platform: p,
                  externalPostId: `ext-${i}`,
                  status: 'PUBLISHED',
                  updatedAt: new Date(),
                })),
            },
            analyticsRecord: {
              create: async (args: { data: { platform: string; publishedPostId: string } }) => {
                created.push({ platform: args.data.platform, publishedPostId: args.data.publishedPostId });
                return { id: `ar-${created.length}` };
              },
            },
          };

          const alerts = new InMemoryAlertDispatcher();
          const svc = new CollectionService(prisma as never, registry as never, noopTokenGate, alerts);

          const report = await svc.runCycle(new Date('2024-06-01T00:00:00Z'));

          const failCount = platforms.filter((p) => p === FAIL).length;
          const okCount = platforms.length - failCount;

          // No record was created for the failing platform (other than the seed).
          const newFailRecords = created.filter((r) => r.platform === FAIL && r.publishedPostId !== 'seed');
          expect(newFailRecords.length).toBe(0);

          // Prior (seed) data for the failing platform is retained, unchanged.
          expect(created.filter((r) => r.platform === FAIL).length).toBe(initialFailCount);

          // Every non-failing platform post still produced exactly one record.
          const newOkRecords = created.filter((r) => r.platform !== FAIL);
          expect(newOkRecords.length).toBe(okCount);

          // Failure is isolated + alerted per failing post.
          expect(report.failures.every((f) => f.platform === FAIL)).toBe(true);
          expect(report.failures.length).toBe(failCount);
          expect(alerts.alerts.length).toBe(failCount);
          expect(alerts.alerts.every((a) => a.kind === 'REFRESH_FAILURE' && a.platform === FAIL)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 6: Retention keeps records at or within the period (inclusive boundary)
  it('Property 6: isRetained is true at/within the period boundary, false just outside', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
        fc.integer({ min: 1, max: 36 }),
        (now, months) => {
          const cutoff = retentionCutoff(now, months).getTime();

          // At the exact boundary -> retained (inclusive).
          expect(isRetained(new Date(cutoff), now, months)).toBe(true);
          // Just inside the period (newer) -> retained.
          expect(isRetained(new Date(cutoff + 1), now, months)).toBe(true);
          // Just outside the period (older than the cutoff) -> dropped.
          expect(isRetained(new Date(cutoff - 1), now, months)).toBe(false);

          // The object form (collectedAt / scoredAt) agrees with the bare timestamp.
          expect(isRetained({ collectedAt: new Date(cutoff) }, now, months)).toBe(true);
          expect(isRetained({ scoredAt: new Date(cutoff - 1) }, now, months)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 7: Derived rates follow their platform formulas
  it('Property 7: computeRates applies the exact per-platform formulas for positive denominators', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PLATFORMS),
        fc.record({
          views: fc.integer({ min: 1, max: 100000 }),
          reach: fc.integer({ min: 1, max: 100000 }),
          leads: fc.integer({ min: 0, max: 100000 }),
          likes: fc.integer({ min: 0, max: 100000 }),
          comments: fc.integer({ min: 0, max: 100000 }),
          shares: fc.integer({ min: 0, max: 100000 }),
          follows: fc.integer({ min: 0, max: 100000 }),
          clickThrough: fc.integer({ min: 0, max: 100000 }),
        }),
        (platform, m) => {
          const { rates, insufficient } = computeRates(platform, m);

          // Positive denominators -> not insufficient.
          expect(insufficient).toBe(false);

          // Conversion / CTA always over views.
          expect(rates.conversionRate).toBe((m.leads / m.views) * 100);
          expect(rates.ctaClickRate).toBe((m.clickThrough / m.views) * 100);

          const engagementNumerator = m.likes + m.comments + m.shares;
          if (platform === 'tiktok') {
            // TikTok: engagement over views, follow_rate not applicable.
            expect(rates.engagementRate).toBe((engagementNumerator / m.views) * 100);
            expect(rates.followRate).toBeNull();
          } else {
            // Facebook / Website: engagement + follow over reach.
            expect(rates.engagementRate).toBe((engagementNumerator / m.reach) * 100);
            expect(rates.followRate).toBe((m.follows / m.reach) * 100);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 10: Rescoring on recovery replaces INSUFFICIENT_DATA with a tier
  it('Property 10: a zero-denominator post is INSUFFICIENT_DATA; once views/reach recover it gets a tier', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PLATFORMS),
        fc.record({
          views: fc.integer({ min: 1, max: 100000 }),
          reach: fc.integer({ min: 1, max: 100000 }),
          leads: fc.integer({ min: 0, max: 100000 }),
          likes: fc.integer({ min: 0, max: 100000 }),
          comments: fc.integer({ min: 0, max: 100000 }),
          shares: fc.integer({ min: 0, max: 100000 }),
          follows: fc.integer({ min: 0, max: 100000 }),
          clickThrough: fc.integer({ min: 0, max: 100000 }),
        }),
        (platform, recovered) => {
          // Before recovery: views (and reach) are zero -> INSUFFICIENT_DATA.
          const before = computeRates(platform, { ...recovered, views: 0, reach: 0 });
          const labelBefore = labelFor(before.rates.conversionRate, before.insufficient, DEFAULT_SCORING_CONFIG);
          expect(labelBefore).toBe('INSUFFICIENT_DATA');

          // After recovery: positive denominators -> a concrete tier, never INSUFFICIENT_DATA.
          const after = computeRates(platform, recovered);
          const labelAfter = labelFor(after.rates.conversionRate, after.insufficient, DEFAULT_SCORING_CONFIG);
          expect(labelAfter).not.toBe('INSUFFICIENT_DATA');
          expect(['HIGH_PERFORMER', 'AVERAGE_PERFORMER', 'LOW_PERFORMER']).toContain(labelAfter);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 11: Performance records are complete
  it('Property 11: a scored Performance_Record carries all 11 features, the rates, label, and scored_at', async () => {
    const scoredAt = new Date('2024-03-15T08:30:00Z');
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          domainCategory: fc.string(),
          contentTopic: fc.string(),
          personaId: fc.string(),
          toneOfVoice: fc.string(),
          objective: fc.constantFrom('Lead', 'View', 'Follow'),
          platform: fc.constantFrom(...PLATFORMS),
          postTimeSlot: fc.constantFrom(...TIME_SLOTS),
          contentLength: fc.nat({ max: 5000 }),
          hasCta: fc.boolean(),
          ctaType: fc.string(),
          mediaType: fc.constantFrom('image', 'video', 'text', 'photo_carousel'),
        }),
        fc.record({
          views: fc.integer({ min: 0, max: 100000 }),
          likes: fc.integer({ min: 0, max: 100000 }),
          shares: fc.integer({ min: 0, max: 100000 }),
          comments: fc.integer({ min: 0, max: 100000 }),
          follows: fc.integer({ min: 0, max: 100000 }),
          leads: fc.integer({ min: 0, max: 100000 }),
          clickThrough: fc.integer({ min: 0, max: 100000 }),
          reach: fc.integer({ min: 0, max: 100000 }),
        }),
        async (features: ContentFeatures, metrics) => {
          let captured: Record<string, unknown> | null = null;
          const prisma = {
            performanceRecord: {
              create: async (args: { data: Record<string, unknown> }) => {
                captured = args.data;
                return { id: 'pr1', ...args.data };
              },
            },
          };
          const svc = new ScoringService(prisma as never, DEFAULT_SCORING_CONFIG, { now: () => scoredAt });

          await svc.scoreRecord({ publishedPostId: 'post-1', platform: features.platform, ...metrics }, features);

          expect(captured).not.toBeNull();
          const rec = captured as Record<string, unknown>;

          // All eleven Content_Features are present and equal to the input.
          expect(rec.domainCategory).toBe(features.domainCategory);
          expect(rec.contentTopic).toBe(features.contentTopic);
          expect(rec.personaId).toBe(features.personaId);
          expect(rec.toneOfVoice).toBe(features.toneOfVoice);
          expect(rec.objective).toBe(features.objective);
          expect(rec.platform).toBe(features.platform);
          expect(rec.postTimeSlot).toBe(features.postTimeSlot);
          expect(rec.contentLength).toBe(features.contentLength);
          expect(rec.hasCta).toBe(features.hasCta);
          expect(rec.ctaType).toBe(features.ctaType);
          expect(rec.mediaType).toBe(features.mediaType);

          // The Derived_Rates.
          expect(typeof rec.conversionRate).toBe('number');
          expect(typeof rec.engagementRate).toBe('number');
          expect(typeof rec.ctaClickRate).toBe('number');
          expect(rec.followRate === null || typeof rec.followRate === 'number').toBe(true);

          // The Performance_Label and the scored_at timestamp.
          expect(LABELS).toContain(rec.performanceLabel as (typeof LABELS)[number]);
          expect(rec.scoredAt).toBe(scoredAt);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: analytics-feedback-loop, Property 12: Empty-data analysis leaves strategy unchanged
  it('Property 12: when every record is INSUFFICIENT_DATA the run skips, calls no Gemini, persists nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (count) => {
        let geminiCalled = false;
        const rows = Array.from({ length: count }, (_unused, i) => ({
          postId: `p-${i}`,
          domainCategory: 'd',
          contentTopic: 't',
          personaId: 'persona',
          toneOfVoice: 'friendly',
          objective: 'Lead',
          platform: 'facebook',
          postTimeSlot: 'morning',
          ctaType: 'link',
          conversionRate: 0,
          engagementRate: 0,
          ctaClickRate: 0,
          followRate: null,
          performanceLabel: 'INSUFFICIENT_DATA',
        }));

        const prisma = {
          performanceRecord: { findMany: async () => rows },
          learningInsight: {
            create: async () => {
              throw new Error('no insight may be persisted on an empty analysis');
            },
          },
          auditEntry: {
            create: async () => {
              throw new Error('no audit entry may be written on an empty analysis');
            },
          },
        };
        const gemini = {
          generateContent: async () => {
            geminiCalled = true;
            return 'patterns';
          },
        };

        const engine = new FeedbackEngine(
          prisma as never,
          gemini as never,
          DEFAULT_FEEDBACK_CONFIG,
          new InMemoryAlertDispatcher(),
          { now: () => new Date('2024-06-02T00:00:00Z') },
        );

        const period: AnalysisPeriod = {
          label: 'w',
          from: new Date('2024-05-26T00:00:00Z'),
          to: new Date('2024-06-02T00:00:00Z'),
        };
        const result = await engine.run(new Date('2024-06-02T00:00:00Z'), period);

        expect(result.outcome).toBe('skipped');
        if (result.outcome === 'skipped') {
          expect(result.reason).toBe('ALL_INSUFFICIENT_DATA');
        }
        // Strategy untouched: Pattern_Recognition never ran.
        expect(geminiCalled).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 17: Conflict resolution is deterministic and conversion-favoring
  it('Property 17: resolveConflicts keeps conversion-backed survivors and is deterministic', () => {
    type Tagged = GeneratedInsight & { tag: number };
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            topic: fc.constantFrom('t1', 't2', 't3'),
            supportedBy: fc.constantFrom<'conversion' | 'engagement'>('conversion', 'engagement'),
          }),
          { minLength: 1, maxLength: 14 },
        ),
        (specs) => {
          const insights: Tagged[] = specs.map((s, i) => ({
            insightType: 'TOPIC_FREQUENCY_ADJUSTMENT',
            subject: { contentTopic: s.topic },
            metrics: {},
            recommendedChange: {},
            confidenceScore: 0.5,
            sampleSize: 5,
            supportedBy: s.supportedBy,
            tag: i,
          }));

          const { kept, discarded } = resolveConflicts(insights);

          // Partition: every input is in exactly one of kept/discarded.
          expect(kept.length + discarded.length).toBe(insights.length);
          const keptTags = new Set(kept.map((k) => k.tag));
          const discardedTags = new Set(discarded.map((d) => d.tag));
          expect(keptTags.size + discardedTags.size).toBe(insights.length);
          for (const tag of keptTags) expect(discardedTags.has(tag)).toBe(false);

          // Exactly one survivor per conflict subject (content_topic here).
          const distinctTopics = new Set(specs.map((s) => s.topic));
          expect(kept.length).toBe(distinctTopics.size);

          // The survivor is conversion-backed whenever the group has any conversion-backed insight.
          for (const topic of distinctTopics) {
            const hadConversion = specs.some((s) => s.topic === topic && s.supportedBy === 'conversion');
            const survivor = kept.find((k) => String((k.subject as Record<string, unknown>).contentTopic) === topic);
            expect(survivor).toBeDefined();
            if (hadConversion) {
              expect(survivor?.supportedBy).toBe('conversion');
            }
          }

          // Deterministic: same input -> same survivors.
          const second = resolveConflicts(insights);
          expect(second.kept.map((k) => k.tag)).toEqual(kept.map((k) => k.tag));
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 20: Reject requires a reason
  it('Property 20: blank reason -> 400 with no status change; a real reason -> REJECTED with the reason stored', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom('', '   ', '\t', '\n  ', '  \t '),
          fc.string(),
        ),
        async (reason) => {
          let updateData: Record<string, unknown> | null = null;
          const prisma = {
            learningInsight: {
              findUnique: async () => ({
                id: 'ins-1',
                insightType: 'LOW_PERFORMER_ALERT',
                insightStatus: 'PENDING_REVIEW',
                subject: {},
                metrics: {},
                recommendedChange: {},
                modifiedChange: null,
                confidenceScore: 0.5,
                sampleSize: 5,
                analysisPeriod: 'w',
                rejectionReason: null,
                generatedAt: new Date(),
              }),
              update: async (args: { data: Record<string, unknown> }) => {
                updateData = args.data;
                return { id: 'ins-1', ...args.data };
              },
            },
            auditEntry: {
              create: async () => ({
                id: 'a-1',
                eventType: 'INSIGHT_REJECTED',
                insightId: 'ins-1',
                actor: 'admin',
                detail: {},
                recordedAt: new Date(),
              }),
            },
          };
          const strategyProcessor = {
            apply: async () => ({ insightId: 'ins-1', touched: [], auditEntryId: 'a-1' }),
          };
          const svc = new InsightService(prisma as never, strategyProcessor as never);

          const isBlank = reason.trim().length === 0;
          if (isBlank) {
            let threw: unknown = null;
            try {
              await svc.reject('ins-1', 'admin', reason);
            } catch (err) {
              threw = err;
            }
            expect(threw).toBeInstanceOf(ValidationError);
            expect((threw as ValidationError).status).toBe(400);
            // No status change occurred.
            expect(updateData).toBeNull();
          } else {
            const result = await svc.reject('ins-1', 'admin', reason);
            expect(result.status).toBe('REJECTED');
            expect(updateData).not.toBeNull();
            const data = updateData as Record<string, unknown>;
            expect(data.insightStatus).toBe('REJECTED');
            expect(data.rejectionReason).toBe(reason.trim());
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 22: Auto_Mode routing
  it('Property 22: disabled -> always REVIEW; enabled -> AUTO_APPLY only for freq<=30% or a time-slot change', () => {
    fc.assert(
      fc.property(
        fc.record({
          insightType: fc.constantFrom(
            'TOPIC_FREQUENCY_ADJUSTMENT',
            'PERSONA_TONE_OPTIMIZATION',
            'OPTIMAL_POSTING_SCHEDULE',
            'LOW_PERFORMER_ALERT',
            'PLATFORM_CONTENT_FIT',
            'OTHER',
          ),
          frequencyDeltaPct: fc.oneof(fc.constant(null), fc.integer({ min: -200, max: 200 })),
          timeSlot: fc.oneof(fc.constant(null), fc.constantFrom('', 'morning', 'evening')),
        }),
        fc.boolean(),
        (change, autoMode) => {
          const result = routeInsight(change, autoMode);

          if (!autoMode) {
            expect(result).toBe('REVIEW');
            return;
          }

          const delta = change.frequencyDeltaPct;
          const isFrequencyAdjustment =
            change.insightType === 'TOPIC_FREQUENCY_ADJUSTMENT' &&
            typeof delta === 'number' &&
            Number.isFinite(delta) &&
            Math.abs(delta) <= AUTO_APPLY_MAX_FREQUENCY_PCT;
          const isTimeSlotChange =
            change.insightType === 'OPTIMAL_POSTING_SCHEDULE' ||
            (typeof change.timeSlot === 'string' && change.timeSlot.length > 0);

          expect(result).toBe(isFrequencyAdjustment || isTimeSlotChange ? 'AUTO_APPLY' : 'REVIEW');
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 25: AI_Prompt_Context production and derivation
  it('Property 25: produceAiContext populates all fields and derives avoid/top topics exactly', () => {
    const proc = new StrategyUpdateProcessor({} as never, { now: () => new Date('2024-07-01T00:00:00Z') });
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom('TOPIC_FREQUENCY_ADJUSTMENT', 'LOW_PERFORMER_ALERT', 'PERSONA_TONE_OPTIMIZATION'),
            topic: fc.constantFrom('t1', 't2', 't3'),
            avg: fc.float({ min: 0, max: 100, noNaN: true }),
          }),
          { maxLength: 16 },
        ),
        (specs) => {
          const now = new Date('2024-07-15T12:00:00Z');
          const insights = specs.map((s, i) => ({
            id: `ins-${i}`,
            insightType: s.type,
            subject: { contentTopic: s.topic },
            metrics: { avgConversionRate: s.avg },
            recommendedChange: { contentTopic: s.topic },
            modifiedChange: null,
          }));

          const ctx = proc.produceAiContext(insights, now);

          // All six (plus version + timestamp) context fields are present.
          expect(ctx.contextVersion.startsWith('v')).toBe(true);
          expect(ctx.lastUpdatedFromAnalytics).toBe(now.toISOString());
          expect(Array.isArray(ctx.topPerformingTopics)).toBe(true);
          expect(Array.isArray(ctx.bestCtaPatterns)).toBe(true);
          expect(Array.isArray(ctx.avoidTopics)).toBe(true);
          expect(typeof ctx.optimalContentLength).toBe('object');
          expect(typeof ctx.toneRecommendations).toBe('object');
          expect(typeof ctx.optimalSchedules).toBe('object');

          // avoid_topics == exactly the distinct topics of LOW_PERFORMER_ALERT insights.
          const expectedAvoid = new Set(specs.filter((s) => s.type === 'LOW_PERFORMER_ALERT').map((s) => s.topic));
          expect(new Set(ctx.avoidTopics.map((t) => t.topic))).toEqual(expectedAvoid);

          // top_performing_topics == exactly the distinct topics of TOPIC_FREQUENCY_ADJUSTMENT insights.
          const expectedTop = new Set(
            specs.filter((s) => s.type === 'TOPIC_FREQUENCY_ADJUSTMENT').map((s) => s.topic),
          );
          expect(new Set(ctx.topPerformingTopics.map((t) => t.topic))).toEqual(expectedTop);
        },
      ),
      { numRuns: 200 },
    );
  });

  /** Build N usable Performance_Record rows for a single content_topic. */
  function usableRows(topic: string, count: number, conv: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_unused, i) => ({
      postId: `${topic}-${i}`,
      domainCategory: 'd',
      contentTopic: topic,
      personaId: 'persona',
      toneOfVoice: 'friendly',
      objective: 'Lead',
      platform: 'facebook',
      postTimeSlot: 'morning',
      ctaType: 'link',
      conversionRate: conv,
      engagementRate: 1,
      ctaClickRate: 1,
      followRate: 1,
      performanceLabel: 'AVERAGE_PERFORMER',
    }));
  }

  // Feature: analytics-feedback-loop, Property 14: Analysis failure leaves strategy unchanged atomically
  it('Property 14: when Gemini fails the run is failed, alerts, and persists no insight/audit (atomic)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 12 }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        async (count, conv) => {
          const rows = usableRows('t', count, conv);
          const prisma = {
            performanceRecord: { findMany: async () => rows },
            learningInsight: {
              create: async () => {
                throw new Error('no insight may be persisted when analysis fails');
              },
            },
            auditEntry: {
              create: async () => {
                throw new Error('no audit entry may be written when analysis fails');
              },
            },
          };
          const gemini = {
            generateContent: async () => {
              throw new Error('gemini down');
            },
          };
          const alerts = new InMemoryAlertDispatcher();

          const engine = new FeedbackEngine(
            prisma as never,
            gemini as never,
            DEFAULT_FEEDBACK_CONFIG,
            alerts,
            { now: () => new Date('2024-06-02T00:00:00Z') },
          );

          const period: AnalysisPeriod = {
            label: 'w',
            from: new Date('2024-05-26T00:00:00Z'),
            to: new Date('2024-06-02T00:00:00Z'),
          };
          const result = await engine.run(new Date('2024-06-02T00:00:00Z'), period);

          expect(result.outcome).toBe('failed');
          if (result.outcome === 'failed') expect(result.reason).toBe('GEMINI');
          // Atomic: nothing persisted (create stubs would have thrown) and the
          // Content_Manager is notified exactly once.
          expect(alerts.alerts.length).toBe(1);
          expect(alerts.alerts[0]?.kind).toBe('REFRESH_FAILURE');
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 15: Generated insights are well-formed
  it('Property 15: every generated insight has one type, metrics, confidence in [0,1], and a sample_size', async () => {
    const VALID_TYPES = [
      'TOPIC_FREQUENCY_ADJUSTMENT',
      'PERSONA_TONE_OPTIMIZATION',
      'OPTIMAL_POSTING_SCHEDULE',
      'LOW_PERFORMER_ALERT',
      'PLATFORM_CONTENT_FIT',
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 12 }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        async (count, conv) => {
          const rows = usableRows('t', count, conv);
          let liId = 0;
          const prisma = {
            performanceRecord: { findMany: async () => rows },
            learningInsight: {
              create: async () => {
                liId += 1;
                return { id: `li-${liId}`, insightStatus: 'PENDING_REVIEW' };
              },
            },
            auditEntry: {
              create: async () => ({ id: `a-${liId}`, recordedAt: new Date() }),
            },
          };
          const gemini = { generateContent: async () => 'patterns' };

          const engine = new FeedbackEngine(
            prisma as never,
            gemini as never,
            DEFAULT_FEEDBACK_CONFIG,
            new InMemoryAlertDispatcher(),
            { now: () => new Date('2024-06-02T00:00:00Z') },
          );

          const period: AnalysisPeriod = {
            label: 'w',
            from: new Date('2024-05-26T00:00:00Z'),
            to: new Date('2024-06-02T00:00:00Z'),
          };
          const result = await engine.run(new Date('2024-06-02T00:00:00Z'), period);

          expect(result.outcome).toBe('analyzed');
          if (result.outcome === 'analyzed') {
            for (const insight of result.insights) {
              expect(VALID_TYPES).toContain(insight.insightType);
              expect(typeof insight.metrics).toBe('object');
              expect(insight.metrics).not.toBeNull();
              expect(Number.isFinite(insight.confidenceScore)).toBe(true);
              expect(insight.confidenceScore).toBeGreaterThanOrEqual(0);
              expect(insight.confidenceScore).toBeLessThanOrEqual(1);
              expect(Number.isInteger(insight.sampleSize)).toBe(true);
              expect(insight.sampleSize).toBeGreaterThanOrEqual(DEFAULT_FEEDBACK_CONFIG.minSample);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Minimal Prisma stub for StrategyUpdateProcessor.apply: captures the persona
   * tone update and the STRATEGY_CHANGE_APPLIED audit detail.
   */
  function makeApplyPrisma(): {
    prisma: Record<string, unknown>;
    captured: { personaTone?: string; auditDetail?: Record<string, unknown> };
  } {
    const captured: { personaTone?: string; auditDetail?: Record<string, unknown> } = {};
    const prisma = {
      contentPersona: {
        update: async (args: { data: { recommendedTone: string } }) => {
          captured.personaTone = args.data.recommendedTone;
          return { id: 'persona', recommendedTone: args.data.recommendedTone };
        },
      },
      learningInsight: { findMany: async () => [] },
      aiPromptContext: {
        findFirst: async () => null,
        create: async () => ({ id: 'ctx-1' }),
        update: async () => ({ id: 'ctx-1' }),
      },
      auditEntry: {
        create: async (args: { data: { detail: Record<string, unknown> } }) => {
          captured.auditDetail = args.data.detail;
          return { id: 'a-1', recordedAt: new Date() };
        },
      },
    };
    return { prisma, captured };
  }

  // Feature: analytics-feedback-loop, Property 21: Modified insights apply the modified change
  it('Property 21: approving a modified insight applies the modified change, not the original', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        async (originalTone, modifiedTone) => {
          const { prisma, captured } = makeApplyPrisma();
          const proc = new StrategyUpdateProcessor(prisma as never, { now: () => new Date('2024-07-01T00:00:00Z') });

          await proc.apply(
            {
              id: 'ins-1',
              insightType: 'PERSONA_TONE_OPTIMIZATION',
              subject: { personaId: 'persona' },
              metrics: {},
              recommendedChange: { personaId: 'persona', recommendedTone: originalTone },
              modifiedChange: modifiedTone === null ? null : { personaId: 'persona', recommendedTone: modifiedTone },
            },
            'REVIEW',
          );

          // The applied tone is the modified one when present, else the original.
          const expectedTone = modifiedTone ?? originalTone;
          expect(captured.personaTone).toBe(expectedTone);

          // The audit's appliedChange reflects the same (modified-superseding) change.
          const applied = (captured.auditDetail?.appliedChange ?? {}) as Record<string, unknown>;
          expect(applied.recommendedTone).toBe(expectedTone);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: analytics-feedback-loop, Property 24: Applied changes touch only relevant components
  it('Property 24: apply() touches AI_CONTEXT always, PERSONA/CALENDAR only for the matching type', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          'TOPIC_FREQUENCY_ADJUSTMENT',
          'PERSONA_TONE_OPTIMIZATION',
          'OPTIMAL_POSTING_SCHEDULE',
          'LOW_PERFORMER_ALERT',
          'PLATFORM_CONTENT_FIT',
        ),
        async (type) => {
          const { prisma } = makeApplyPrisma();
          const proc = new StrategyUpdateProcessor(prisma as never, { now: () => new Date('2024-07-01T00:00:00Z') });

          const applied = await proc.apply(
            {
              id: 'ins-1',
              insightType: type,
              subject: { personaId: 'persona', contentTopic: 't' },
              metrics: {},
              // Provide enough fields that a persona tone change is applicable.
              recommendedChange: { personaId: 'persona', recommendedTone: 'warm', contentTopic: 't' },
              modifiedChange: null,
            },
            'REVIEW',
          );

          const touched = new Set(applied.touched);

          // AI_Prompt_Context is always refreshed.
          expect(touched.has('AI_CONTEXT')).toBe(true);

          // PERSONA only for a persona-tone insight.
          expect(touched.has('PERSONA')).toBe(type === 'PERSONA_TONE_OPTIMIZATION');

          // CALENDAR only for a topic-frequency insight.
          expect(touched.has('CALENDAR')).toBe(type === 'TOPIC_FREQUENCY_ADJUSTMENT');

          // Never both persona and calendar at once.
          expect(touched.has('PERSONA') && touched.has('CALENDAR')).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 28: Audit log is append-only
  it('Property 28: AuditLog exposes only append+read; the log grows monotonically and never mutates prior entries', async () => {
    // API-surface guarantee: no mutation path exists on the AuditLog type.
    const surfaceProbe = new AuditLog({} as never);
    for (const method of ['update', 'delete', 'remove', 'destroy', 'edit', 'clear']) {
      expect((surfaceProbe as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }

    const EVENTS = [
      'INSIGHT_GENERATED',
      'INSIGHT_APPROVED',
      'INSIGHT_REJECTED',
      'CONFLICT_RESOLVED',
      'STRATEGY_CHANGE_APPLIED',
    ] as const;

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            eventType: fc.constantFrom(...EVENTS),
            insightId: fc.string(),
            actor: fc.constantFrom('admin', 'AUTO_MODE', 'background-worker'),
            detail: fc.dictionary(fc.string(), fc.string(), { maxKeys: 4 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (ops) => {
          // In-memory store backing the append-only repository.
          const store: Array<Record<string, unknown>> = [];
          let seq = 0;
          const prisma = {
            auditEntry: {
              create: async (args: { data: Record<string, unknown> }) => {
                seq += 1;
                const row = {
                  id: `e-${seq}`,
                  recordedAt: new Date(1_700_000_000_000 + seq * 1000),
                  ...args.data,
                };
                store.push(row);
                return row;
              },
              findMany: async (a?: { skip?: number; take?: number }) => {
                const sorted = [...store].sort((x, y) => (y.recordedAt as Date).getTime() - (x.recordedAt as Date).getTime());
                const skip = a?.skip ?? 0;
                const take = a?.take ?? sorted.length;
                return sorted.slice(skip, skip + take);
              },
              count: async () => store.length,
            },
          };

          const log = new AuditLog(prisma as never);

          let prevTotal = 0;
          const seen = new Map<string, string>(); // id -> JSON snapshot
          for (const op of ops) {
            const entry = await log.append(op.eventType, op.insightId, op.actor, op.detail);
            seen.set(entry.id, JSON.stringify(entry));

            const { total } = await log.listRecent(1, 1000);
            // Monotonic non-decreasing length, growing by exactly one per append.
            expect(total).toBe(prevTotal + 1);
            prevTotal = total;

            // Every previously written entry is still present and unchanged.
            const all = await log.listRecent(1, 1000);
            for (const [id, snapshot] of seen) {
              const found = all.items.find((it) => it.id === id);
              expect(found).toBeDefined();
              expect(JSON.stringify(found)).toBe(snapshot);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
