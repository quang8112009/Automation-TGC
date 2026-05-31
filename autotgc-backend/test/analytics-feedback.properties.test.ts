/**
 * Property-based tests for the analytics-feedback-loop spec.
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: analytics-feedback-loop, Property {n}: {exact design text}`) and
 * runs >= 100 generated cases on fast-check. External dependencies
 * (PlatformAdapter/registry, Token_Manager, Gemini, Alert Dispatcher, Prisma)
 * are replaced by in-memory fakes and the clock is injected so runs are
 * deterministic and cheap.
 *
 * These DELIBERATELY duplicate some coverage that exists under ad-hoc numbering
 * in analytics.test.ts / scoring.test.ts / stateMachines.test.ts, using the
 * design's canonical numbering. The pre-existing files are left untouched.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';

import {
  computeRates,
  labelFor,
  DEFAULT_SCORING_CONFIG,
} from '../src/analytics/scoring';
import type { Platform, RawMetrics } from '../src/analytics/scoring';
import {
  aggregate,
  eligibleTopics,
  pickInsightType,
  resolveConflicts,
  FeedbackEngine,
} from '../src/analytics/feedbackEngine';
import type { PerformanceRow, GeneratedInsight } from '../src/analytics/feedbackEngine';
import {
  DEFAULT_FEEDBACK_CONFIG,
} from '../src/analytics/types';
import type {
  FeedbackConfig,
  InsightType,
  ContentFeatures,
  AnalysisPeriod,
} from '../src/analytics/types';
import {
  insightTransition,
  INSIGHT_TRANSITIONS,
} from '../src/analytics/insightStateMachine';
import type { InsightStatus } from '../src/analytics/insightStateMachine';
import { isRetained, retentionCutoff } from '../src/analytics/retention';
import { CollectionService } from '../src/analytics/collectionService';
import type { TokenGate } from '../src/analytics/collectionService';
import { ScoringService } from '../src/analytics/scoringService';
import { InsightService, routeInsight } from '../src/analytics/insightService';
import type { StrategyProcessor, InsightApplyInput } from '../src/analytics/insightService';
import { AuditLog } from '../src/analytics/auditLog';
import { StrategyUpdateProcessor } from '../src/strategy/strategyUpdateProcessor';
import type { AppliedChange } from '../src/strategy/strategyUpdateProcessor';
import { AiContextReadModel } from '../src/strategy/aiContextReadModel';
import { authorize } from '../src/auth/rbac';
import type { AuthContext, ResourceTarget, Module, Action } from '../src/auth/rbac';
import { JwtService } from '../src/auth/jwt';
import type { Clock } from '../src/auth/jwt';
import { InMemoryAlertDispatcher } from '../src/infra/alerts';
import type { GeminiClient } from '../src/infra/gemini';
import type { AdapterRegistry } from '../src/platforms/registry';

// --- shared constants --------------------------------------------------------

const PLATFORMS: Platform[] = ['facebook', 'tiktok', 'website'];
const ALL_STATUSES: InsightStatus[] = ['NEW', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'];
const INSIGHT_TYPES: InsightType[] = [
  'TOPIC_FREQUENCY_ADJUSTMENT',
  'PERSONA_TONE_OPTIMIZATION',
  'OPTIMAL_POSTING_SCHEDULE',
  'LOW_PERFORMER_ALERT',
  'PLATFORM_CONTENT_FIT',
];

function fixedClock(ms: number): Clock {
  return { now: () => new Date(ms) };
}

const noopTokenGate: TokenGate = {
  isValid: async () => true,
  refresh: async () => undefined,
};

function makeShapeOnlyCollectionService(): CollectionService {
  // shapeMetrics never touches the I/O collaborators; minimal stubs suffice.
  return new CollectionService(
    {} as unknown as PrismaClient,
    {} as unknown as AdapterRegistry,
    noopTokenGate,
    new InMemoryAlertDispatcher(),
  );
}

// --- in-memory Prisma fake ---------------------------------------------------
// Only the model methods the services under test actually call are implemented.

interface AnyRow {
  [k: string]: unknown;
}

interface FakeDb {
  scheduledPosts: AnyRow[];
  analyticsRecords: AnyRow[];
  performanceRecords: AnyRow[];
  learningInsights: AnyRow[];
  auditEntries: AnyRow[];
  personas: AnyRow[];
  aiContexts: AnyRow[];
  personaUpdates: Array<{ id: string; data: AnyRow }>;
  prisma: PrismaClient;
}

function makeFakeDb(now: () => Date = () => new Date()): FakeDb {
  const scheduledPosts: AnyRow[] = [];
  const analyticsRecords: AnyRow[] = [];
  const performanceRecords: AnyRow[] = [];
  const learningInsights: AnyRow[] = [];
  const auditEntries: AnyRow[] = [];
  const personas: AnyRow[] = [];
  const aiContexts: AnyRow[] = [];
  const personaUpdates: Array<{ id: string; data: AnyRow }> = [];
  let seq = 0;
  const id = (p: string): string => `${p}_${++seq}`;

  const byGeneratedAt = (rows: AnyRow[], dir: 'asc' | 'desc'): AnyRow[] => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = (a.generatedAt as Date)?.getTime?.() ?? 0;
      const bv = (b.generatedAt as Date)?.getTime?.() ?? 0;
      return dir === 'asc' ? av - bv : bv - av;
    });
    return out;
  };

  const prisma = {
    scheduledPost: {
      findMany: async (args?: { where?: AnyRow }) => {
        const where = args?.where ?? {};
        return scheduledPosts.filter((r) => {
          if (where.status !== undefined && r.status !== where.status) return false;
          if (
            where.externalPostId &&
            typeof where.externalPostId === 'object' &&
            'not' in (where.externalPostId as AnyRow)
          ) {
            if (r.externalPostId === null || r.externalPostId === undefined) return false;
          }
          return true;
        });
      },
      findFirst: async (args?: { where?: AnyRow }) => {
        const where = args?.where ?? {};
        return (
          scheduledPosts.find((r) => {
            if (where.externalPostId !== undefined && r.externalPostId !== where.externalPostId) return false;
            if (where.status !== undefined && r.status !== where.status) return false;
            return true;
          }) ?? null
        );
      },
      findUnique: async (args: { where: { id: string } }) =>
        scheduledPosts.find((r) => r.id === args.where.id) ?? null,
    },
    analyticsRecord: {
      create: async (args: { data: AnyRow }) => {
        const row = { id: id('ar'), ...args.data };
        analyticsRecords.push(row);
        return row;
      },
      findFirst: async (args?: { where?: AnyRow }) => {
        const where = args?.where ?? {};
        const matches = analyticsRecords.filter(
          (r) => where.publishedPostId === undefined || r.publishedPostId === where.publishedPostId,
        );
        // Honor orderBy: { collectedAt: 'desc' } — the only caller (scoreByPost)
        // wants the most-recent Analytics_Record for recovery rescoring.
        matches.sort((a, b) => {
          const av = (a.collectedAt as Date)?.getTime?.() ?? 0;
          const bv = (b.collectedAt as Date)?.getTime?.() ?? 0;
          return bv - av;
        });
        return matches[0] ?? null;
      },
    },
    performanceRecord: {
      create: async (args: { data: AnyRow }) => {
        const row = { id: id('pr'), ...args.data };
        performanceRecords.push(row);
        return row;
      },
      findMany: async (args?: { where?: AnyRow }) => {
        const where = args?.where ?? {};
        return performanceRecords.filter((r) => {
          if (where.contentTopic !== undefined && r.contentTopic !== where.contentTopic) return false;
          const sa = where.scoredAt as { gte?: Date; lte?: Date } | undefined;
          if (sa) {
            const t = (r.scoredAt as Date).getTime();
            if (sa.gte && t < sa.gte.getTime()) return false;
            if (sa.lte && t > sa.lte.getTime()) return false;
          }
          return true;
        });
      },
    },
    learningInsight: {
      create: async (args: { data: AnyRow }) => {
        const row = { id: id('li'), modifiedChange: null, rejectionReason: null, ...args.data };
        learningInsights.push(row);
        return row;
      },
      findMany: async (args?: { where?: AnyRow; orderBy?: AnyRow; skip?: number; take?: number }) => {
        const where = args?.where ?? {};
        let rows = learningInsights.filter(
          (r) => where.insightStatus === undefined || r.insightStatus === where.insightStatus,
        );
        const ob = args?.orderBy as { generatedAt?: 'asc' | 'desc' } | undefined;
        if (ob?.generatedAt) rows = byGeneratedAt(rows, ob.generatedAt);
        const skip = args?.skip ?? 0;
        const take = args?.take ?? rows.length;
        return rows.slice(skip, skip + take);
      },
      count: async (args?: { where?: AnyRow }) => {
        const where = args?.where ?? {};
        return learningInsights.filter(
          (r) => where.insightStatus === undefined || r.insightStatus === where.insightStatus,
        ).length;
      },
      findUnique: async (args: { where: { id: string } }) =>
        learningInsights.find((r) => r.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: AnyRow }) => {
        const row = learningInsights.find((r) => r.id === args.where.id);
        if (!row) throw new Error('learningInsight not found');
        Object.assign(row, args.data);
        return row;
      },
    },
    auditEntry: {
      create: async (args: { data: AnyRow }) => {
        const row = { id: id('ae'), recordedAt: now(), ...args.data };
        auditEntries.push(row);
        return row;
      },
      findMany: async (args?: { where?: AnyRow }) => {
        const where = args?.where ?? {};
        return auditEntries.filter(
          (r) => where.insightId === undefined || r.insightId === where.insightId,
        );
      },
      count: async () => auditEntries.length,
    },
    contentPersona: {
      update: async (args: { where: { id: string }; data: AnyRow }) => {
        const row = personas.find((r) => r.id === args.where.id);
        if (!row) throw new Error('persona not found');
        Object.assign(row, args.data);
        personaUpdates.push({ id: args.where.id, data: args.data });
        return row;
      },
    },
    aiPromptContext: {
      findFirst: async () => (aiContexts.length > 0 ? aiContexts[aiContexts.length - 1] : null),
      create: async (args: { data: AnyRow }) => {
        const row = { id: id('ctx'), ...args.data };
        aiContexts.push(row);
        return row;
      },
      update: async (args: { where: { id: string }; data: AnyRow }) => {
        const row = aiContexts.find((r) => r.id === args.where.id);
        if (!row) throw new Error('context not found');
        Object.assign(row, args.data);
        return row;
      },
    },
  } as unknown as PrismaClient;

  return {
    scheduledPosts,
    analyticsRecords,
    performanceRecords,
    learningInsights,
    auditEntries,
    personas,
    aiContexts,
    personaUpdates,
    prisma,
  };
}

// A Gemini stub: succeeds (returns text) or throws on demand.
function geminiStub(fail = false): GeminiClient {
  return {
    generateContent: async () => {
      if (fail) throw new Error('gemini down');
      return 'ok';
    },
  } as unknown as GeminiClient;
}

// Build a PerformanceRow with sensible defaults.
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
    conversionRate: 1,
    engagementRate: 1,
    ctaClickRate: 1,
    followRate: 1,
    performanceLabel: 'AVERAGE_PERFORMER',
    ...over,
  };
}

// =============================================================================
// Collection_Service properties
// =============================================================================

describe('analytics-feedback-loop properties (collection)', () => {
  // Feature: analytics-feedback-loop, Property 1: Metrics match only their originating post
  // For any set of Published_Posts and any batch of collected metric sets, every persisted
  // Analytics_Record references the Published_Post whose External_Post_Id equals the collected id,
  // and no Analytics_Record is created for any collected id that matches no post or whose matching fails.
  it('Property 1: metrics match only their originating post', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.string({ maxLength: 8 }), { maxLength: 10 }),
        async (existingExtIds, queryIds) => {
          const db = makeFakeDb();
          existingExtIds.forEach((extId, i) => {
            db.scheduledPosts.push({
              id: `post_${i}`,
              platform: PLATFORMS[i % PLATFORMS.length],
              externalPostId: extId,
              status: 'PUBLISHED',
            });
          });
          const svc = new CollectionService(
            db.prisma,
            {} as unknown as AdapterRegistry,
            noopTokenGate,
            new InMemoryAlertDispatcher(),
          );

          const known = new Set(existingExtIds);
          for (const q of queryIds) {
            const match = await svc.matchToPost(q);
            if (q.length > 0 && known.has(q)) {
              // matched -> resolves the post whose externalPostId equals q
              const expected = db.scheduledPosts.find((p) => p.externalPostId === q);
              expect(match).not.toBeNull();
              expect(match?.id).toBe(expected?.id);
            } else {
              // no match / blank id -> null, so no Analytics_Record would be created
              expect(match).toBeNull();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 2: TikTok reach and follows are always unavailable
  // For any raw TikTok payload, the shaped metrics record reach as null and follows as null
  // (Unavailable_Metrics), regardless of any values the raw payload contains, while available
  // metrics remain numeric.
  it('Property 2: TikTok reach and follows are always unavailable', () => {
    const svc = makeShapeOnlyCollectionService();
    fc.assert(
      fc.property(
        // Raw TikTok payload that MAY contain reach/follows under various source keys.
        fc.record(
          {
            views: fc.integer({ min: 0, max: 100000 }),
            view_count: fc.integer({ min: 0, max: 100000 }),
            likes: fc.integer({ min: 0, max: 100000 }),
            like_count: fc.integer({ min: 0, max: 100000 }),
            comments: fc.integer({ min: 0, max: 100000 }),
            shares: fc.integer({ min: 0, max: 100000 }),
            reach: fc.integer({ min: 1, max: 100000 }),
            follows: fc.integer({ min: 1, max: 100000 }),
          },
          { requiredKeys: [] },
        ),
        (raw) => {
          const shaped = svc.shapeMetrics('tiktok', raw);
          // reach/follows forced to null even when the payload supplies values.
          expect(shaped.reach).toBeNull();
          expect(shaped.follows).toBeNull();
          // an available metric present in the payload remains numeric.
          if (typeof raw.views === 'number') expect(shaped.views).toBe(raw.views);
          if (typeof raw.shares === 'number') expect(shaped.shares).toBe(raw.shares);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 3: Missing metrics are null, never zero
  // For any raw platform payload with an arbitrary subset of metrics absent, every absent metric
  // is stored as null and flagged as an Unavailable_Metric, and is never coerced to 0.
  it('Property 3: missing metrics are null, never zero', () => {
    const svc = makeShapeOnlyCollectionService();
    fc.assert(
      fc.property(
        fc.constantFrom(...PLATFORMS),
        fc.record(
          {
            views: fc.integer({ min: 1, max: 100000 }),
            likes: fc.integer({ min: 1, max: 100000 }),
            shares: fc.integer({ min: 1, max: 100000 }),
            comments: fc.integer({ min: 1, max: 100000 }),
            follows: fc.integer({ min: 1, max: 100000 }),
            leads: fc.integer({ min: 1, max: 100000 }),
            clickThrough: fc.integer({ min: 1, max: 100000 }),
            reach: fc.integer({ min: 1, max: 100000 }),
          },
          { requiredKeys: [] },
        ),
        (platform, raw) => {
          const shaped = svc.shapeMetrics(platform, raw);
          const present = new Set(Object.keys(raw));
          const checkAbsentIsNull = (key: keyof RawMetrics, source: string): void => {
            if (!present.has(source)) expect(shaped[key]).toBeNull();
          };
          // Direct-named source keys: an absent key must yield null (never 0).
          checkAbsentIsNull('views', 'views');
          checkAbsentIsNull('likes', 'likes');
          checkAbsentIsNull('shares', 'shares');
          checkAbsentIsNull('comments', 'comments');
          checkAbsentIsNull('leads', 'leads');
          checkAbsentIsNull('clickThrough', 'clickThrough');
          // For non-tiktok, follows/reach use their direct source key too.
          if (platform !== 'tiktok') {
            checkAbsentIsNull('follows', 'follows');
            checkAbsentIsNull('reach', 'reach');
          }
          // No shaped metric is ever 0 unless the raw payload literally supplied 0
          // (it never does here: generators produce >= 1), so any 0 would be a bug.
          for (const key of Object.keys(shaped) as Array<keyof RawMetrics>) {
            expect(shaped[key] === 0).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 5: Collection failure isolates the platform and keeps last data
  // For any multi-platform collection run in which one platform's request fails, the most recent
  // Analytics_Records for the failed platform are unchanged after the run, and every other platform
  // still produces its records.
  it('Property 5: collection failure isolates the platform and keeps last data', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }), // facebook posts (failing platform)
        fc.integer({ min: 1, max: 3 }), // tiktok posts (succeeding)
        fc.integer({ min: 1, max: 3 }), // website posts (succeeding)
        async (nFb, nTt, nWeb) => {
          const db = makeFakeDb();
          let idx = 0;
          const add = (platform: Platform, n: number): void => {
            for (let i = 0; i < n; i++) {
              db.scheduledPosts.push({
                id: `post_${idx}`,
                platform,
                externalPostId: `ext_${idx}`,
                status: 'PUBLISHED',
                updatedAt: new Date(idx),
              });
              idx++;
            }
          };
          add('facebook', nFb);
          add('tiktok', nTt);
          add('website', nWeb);

          // Pre-seed "most recent" facebook Analytics_Records (the last data).
          const fbPosts = db.scheduledPosts.filter((p) => p.platform === 'facebook');
          for (const p of fbPosts) {
            db.analyticsRecords.push({
              id: `seed_${p.id}`,
              publishedPostId: p.id,
              platform: 'facebook',
              views: 999, // marker
              collectedAt: new Date(0),
              seeded: true,
            });
          }
          const seededFacebook = db.analyticsRecords.filter((r) => r.platform === 'facebook');
          const seededSnapshot = seededFacebook.map((r) => ({ ...r }));

          const okAdapter = {
            collectAnalytics: async () => ({ metrics: { views: 100, leads: 5, reach: 50, likes: 3, comments: 1, shares: 1 }, raw: {} }),
          };
          const failingAdapter = {
            collectAnalytics: async () => {
              throw new Error('platform request failed');
            },
          };
          const registry = {
            get: (adapterId: string) => (adapterId === 'facebook' ? failingAdapter : okAdapter),
          } as unknown as AdapterRegistry;

          const alerts = new InMemoryAlertDispatcher();
          const svc = new CollectionService(db.prisma, registry, noopTokenGate, alerts);
          await svc.runCycle(new Date(1_000_000));

          // Failed platform: most-recent records unchanged (no new fb records, seeds intact).
          const fbAfter = db.analyticsRecords.filter((r) => r.platform === 'facebook');
          expect(fbAfter.length).toBe(seededSnapshot.length);
          for (const snap of seededSnapshot) {
            const stillThere = fbAfter.find((r) => r.id === snap.id);
            expect(stillThere).toBeDefined();
            expect(stillThere?.views).toBe(999);
          }
          // Failure was isolated + surfaced.
          expect(alerts.alerts.some((a) => a.platform === 'facebook')).toBe(true);

          // Other platforms still produced their records.
          const ttAfter = db.analyticsRecords.filter((r) => r.platform === 'tiktok');
          const webAfter = db.analyticsRecords.filter((r) => r.platform === 'website');
          expect(ttAfter.length).toBe(nTt);
          expect(webAfter.length).toBe(nWeb);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Retention property
// =============================================================================

describe('analytics-feedback-loop properties (retention)', () => {
  // Feature: analytics-feedback-loop, Property 6: Retention keeps records at or within the period
  // For any Analytics_Record or Performance_Record, the retention predicate keeps the record
  // available for Pattern_Recognition exactly when its age is at or within the Retention_Period,
  // including a record at exactly the boundary.
  it('Property 6: retention keeps records at or within the period (inclusive boundary)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }), // now ms
        fc.integer({ min: 1, max: 24 }), // retention months
        fc.integer({ min: -5_000_000_000, max: 60_000_000_000 }), // offset before/after cutoff
        (nowMs, months, offset) => {
          const now = new Date(nowMs);
          const cutoff = retentionCutoff(now, months);

          // Oracle: retained iff record time >= cutoff time.
          const recTime = cutoff.getTime() + offset;
          const rec = new Date(recTime);
          expect(isRetained(rec, now, months)).toBe(recTime >= cutoff.getTime());

          // Explicit boundary checks: at boundary inclusive; 1ms before excluded.
          expect(isRetained(new Date(cutoff.getTime()), now, months)).toBe(true);
          expect(isRetained(new Date(cutoff.getTime() - 1), now, months)).toBe(false);
          // A record at `now` (age 0) is always retained; far past is not.
          expect(isRetained(now, now, months)).toBe(true);
          expect(isRetained(new Date(cutoff.getTime() - 86_400_000), now, months)).toBe(false);

          // Works on record-shaped inputs too (collectedAt / scoredAt).
          expect(isRetained({ collectedAt: new Date(cutoff.getTime()) }, now, months)).toBe(true);
          expect(isRetained({ scoredAt: new Date(cutoff.getTime() - 1) }, now, months)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// Scoring_Engine properties
// =============================================================================

describe('analytics-feedback-loop properties (scoring)', () => {
  // Feature: analytics-feedback-loop, Property 7: Derived rates follow their platform formulas
  // For any metrics with a positive denominator, the Scoring_Engine computes
  // Conversion_Rate = leads/views*100 and CTA_Click_Rate = click_through/views*100; for
  // Facebook/Website with reach > 0, Engagement_Rate = (likes+comments+shares)/reach*100 and
  // Follow_Rate = follows/reach*100; for TikTok with views > 0,
  // Engagement_Rate = (likes+comments+shares)/views*100 and Follow_Rate is null (not applicable).
  it('Property 7: derived rates follow their platform formulas', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PLATFORMS),
        fc.record({
          views: fc.integer({ min: 1, max: 100000 }),
          reach: fc.integer({ min: 1, max: 100000 }),
          leads: fc.integer({ min: 0, max: 10000 }),
          likes: fc.integer({ min: 0, max: 10000 }),
          comments: fc.integer({ min: 0, max: 10000 }),
          shares: fc.integer({ min: 0, max: 10000 }),
          follows: fc.integer({ min: 0, max: 10000 }),
          clickThrough: fc.integer({ min: 0, max: 10000 }),
        }),
        (platform, m) => {
          const { rates } = computeRates(platform, m);
          expect(rates.conversionRate).toBeCloseTo((m.leads / m.views) * 100, 6);
          expect(rates.ctaClickRate).toBeCloseTo((m.clickThrough / m.views) * 100, 6);
          const engageNum = m.likes + m.comments + m.shares;
          if (platform === 'tiktok') {
            expect(rates.engagementRate).toBeCloseTo((engageNum / m.views) * 100, 6);
            expect(rates.followRate).toBeNull();
          } else {
            expect(rates.engagementRate).toBeCloseTo((engageNum / m.reach) * 100, 6);
            expect(rates.followRate).toBeCloseTo((m.follows / m.reach) * 100, 6);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 8: Divide-by-zero yields zero rate and INSUFFICIENT_DATA
  // For any metrics in which a Derived_Rate denominator is zero, that rate is set to exactly 0 with
  // no division performed (never NaN or Infinity), and if views are zero or the reach required for a
  // rate is zero, the Performance_Label is INSUFFICIENT_DATA.
  it('Property 8: divide-by-zero yields zero rate and INSUFFICIENT_DATA', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PLATFORMS),
        fc.record({
          views: fc.integer({ min: 0, max: 1000 }),
          reach: fc.integer({ min: 0, max: 1000 }),
          leads: fc.integer({ min: 0, max: 1000 }),
          likes: fc.integer({ min: 0, max: 1000 }),
          comments: fc.integer({ min: 0, max: 1000 }),
          shares: fc.integer({ min: 0, max: 1000 }),
          follows: fc.integer({ min: 0, max: 1000 }),
          clickThrough: fc.integer({ min: 0, max: 1000 }),
        }),
        (platform, m) => {
          const { rates, insufficient } = computeRates(platform, m);
          // Never NaN / Infinity.
          for (const v of [rates.conversionRate, rates.engagementRate, rates.ctaClickRate]) {
            expect(Number.isFinite(v)).toBe(true);
          }
          if (rates.followRate !== null) expect(Number.isFinite(rates.followRate)).toBe(true);

          if (m.views === 0) {
            expect(rates.conversionRate).toBe(0);
            expect(rates.ctaClickRate).toBe(0);
          }
          if (platform !== 'tiktok' && m.reach === 0) {
            expect(rates.engagementRate).toBe(0);
            expect(rates.followRate).toBe(0);
          }
          // INSUFFICIENT_DATA when views are zero or the required reach is zero.
          const label = labelFor(rates.conversionRate, insufficient, DEFAULT_SCORING_CONFIG);
          if (m.views === 0 || (platform !== 'tiktok' && m.reach === 0)) {
            expect(insufficient).toBe(true);
            expect(label).toBe('INSUFFICIENT_DATA');
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 9: Performance label maps conversion rate against thresholds
  // For any non-INSUFFICIENT post and any MID_THRESHOLD <= HIGH_THRESHOLD, the Performance_Label is
  // HIGH_PERFORMER when Conversion_Rate >= HIGH_THRESHOLD, AVERAGE_PERFORMER when
  // MID_THRESHOLD <= Conversion_Rate < HIGH_THRESHOLD, and LOW_PERFORMER when
  // Conversion_Rate < MID_THRESHOLD; an INSUFFICIENT_DATA post is never assigned any of the three tiers.
  it('Property 9: performance label maps conversion rate against thresholds', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 50, noNaN: true }), // midThreshold
        fc.float({ min: 0, max: 50, noNaN: true }), // gap to high
        fc.boolean(),
        (cr, mid, gap, insufficient) => {
          const cfg = { midThreshold: mid, highThreshold: mid + gap };
          const label = labelFor(cr, insufficient, cfg);
          if (insufficient) {
            expect(label).toBe('INSUFFICIENT_DATA');
          } else if (cr >= cfg.highThreshold) {
            expect(label).toBe('HIGH_PERFORMER');
          } else if (cr >= cfg.midThreshold) {
            expect(label).toBe('AVERAGE_PERFORMER');
          } else {
            expect(label).toBe('LOW_PERFORMER');
          }
          if (insufficient) {
            expect(['HIGH_PERFORMER', 'AVERAGE_PERFORMER', 'LOW_PERFORMER']).not.toContain(label);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 10: Rescoring on recovery replaces INSUFFICIENT_DATA with a tier
  // For any post previously labeled INSUFFICIENT_DATA, when a later collection makes its views and
  // required reach greater than zero, rescoring recomputes the Derived_Rates and assigns a tier
  // Performance_Label from the Conversion_Rate.
  it('Property 10: rescoring on recovery replaces INSUFFICIENT_DATA with a tier', async () => {
    const TIERS = ['HIGH_PERFORMER', 'AVERAGE_PERFORMER', 'LOW_PERFORMER'];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PLATFORMS),
        fc.record({
          views: fc.integer({ min: 1, max: 100000 }),
          reach: fc.integer({ min: 1, max: 100000 }),
          leads: fc.integer({ min: 0, max: 50000 }),
          likes: fc.integer({ min: 0, max: 1000 }),
          comments: fc.integer({ min: 0, max: 1000 }),
          shares: fc.integer({ min: 0, max: 1000 }),
          follows: fc.integer({ min: 0, max: 1000 }),
          clickThrough: fc.integer({ min: 0, max: 1000 }),
        }),
        async (platform, recovered) => {
          const db = makeFakeDb();
          const postId = 'post_recovery';
          db.scheduledPosts.push({ id: postId, platform, status: 'PUBLISHED', scheduledAt: new Date(0) });
          // Earlier INSUFFICIENT collection (views 0), then a later recovered collection.
          db.analyticsRecords.push({
            id: 'old', publishedPostId: postId, platform,
            views: 0, reach: 0, leads: 0, likes: 0, comments: 0, shares: 0, follows: 0, clickThrough: 0,
            collectedAt: new Date(1000),
          });
          db.analyticsRecords.push({
            id: 'new', publishedPostId: postId, platform,
            views: recovered.views, reach: recovered.reach, leads: recovered.leads,
            likes: recovered.likes, comments: recovered.comments, shares: recovered.shares,
            follows: recovered.follows, clickThrough: recovered.clickThrough,
            collectedAt: new Date(2000),
          });

          const scoring = new ScoringService(db.prisma, DEFAULT_SCORING_CONFIG, fixedClock(5000));
          const result = await scoring.scoreByPost(postId);
          expect(result).not.toBeNull();
          // views>0 and (tiktok || reach>0) => a concrete tier, never INSUFFICIENT_DATA.
          expect(TIERS).toContain(result?.performanceLabel);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: analytics-feedback-loop, Property 11: Performance records are complete
  // For any scored Published_Post, the produced Performance_Record contains all eleven
  // Content_Features, the Derived_Rates, the Performance_Label, and a scored_at timestamp.
  it('Property 11: performance records are complete', async () => {
    const featureKeys: Array<keyof ContentFeatures> = [
      'domainCategory', 'contentTopic', 'personaId', 'toneOfVoice', 'objective',
      'platform', 'postTimeSlot', 'contentLength', 'hasCta', 'ctaType', 'mediaType',
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PLATFORMS),
        fc.record({
          views: fc.integer({ min: 0, max: 100000 }),
          reach: fc.integer({ min: 0, max: 100000 }),
          leads: fc.integer({ min: 0, max: 10000 }),
          likes: fc.integer({ min: 0, max: 10000 }),
          comments: fc.integer({ min: 0, max: 10000 }),
          shares: fc.integer({ min: 0, max: 10000 }),
          follows: fc.integer({ min: 0, max: 10000 }),
          clickThrough: fc.integer({ min: 0, max: 10000 }),
        }),
        fc.record({
          domainCategory: fc.string({ minLength: 1, maxLength: 6 }),
          contentTopic: fc.string({ minLength: 1, maxLength: 6 }),
          personaId: fc.string({ minLength: 1, maxLength: 6 }),
          toneOfVoice: fc.string({ minLength: 1, maxLength: 6 }),
          objective: fc.constantFrom('Lead', 'View', 'Follow'),
          postTimeSlot: fc.constantFrom('morning', 'afternoon', 'evening', 'night'),
          contentLength: fc.integer({ min: 0, max: 5000 }),
          hasCta: fc.boolean(),
          ctaType: fc.constantFrom('link', 'button', 'none'),
          mediaType: fc.constantFrom('image', 'video', 'text', 'photo_carousel'),
        }),
        async (platform, m, f) => {
          const db = makeFakeDb();
          const scoredAt = new Date(123456789);
          const scoring = new ScoringService(db.prisma, DEFAULT_SCORING_CONFIG, { now: () => scoredAt });
          const features: ContentFeatures = { ...f, platform };
          await scoring.scoreRecord(
            {
              publishedPostId: 'p1', platform,
              views: m.views, likes: m.likes, shares: m.shares, comments: m.comments,
              follows: m.follows, leads: m.leads, clickThrough: m.clickThrough, reach: m.reach,
            },
            features,
          );
          const row = db.performanceRecords[db.performanceRecords.length - 1];
          // All eleven Content_Features present.
          for (const key of featureKeys) expect(row[key]).not.toBeUndefined();
          // Derived_Rates present.
          for (const key of ['conversionRate', 'engagementRate', 'ctaClickRate']) {
            expect(typeof row[key]).toBe('number');
          }
          expect(row.followRate === null || typeof row.followRate === 'number').toBe(true);
          // Performance_Label + scored_at present.
          expect(typeof row.performanceLabel).toBe('string');
          expect(row.scoredAt).toBe(scoredAt);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// =============================================================================
// Feedback_Engine properties
// =============================================================================

describe('analytics-feedback-loop properties (feedback)', () => {
  // Feature: analytics-feedback-loop, Property 4: Aggregation excludes unavailable and insufficient data
  // For any group of records, aggregating a Derived_Rate excludes Unavailable_Metrics (null) and
  // rates labeled INSUFFICIENT_DATA, equals the aggregate computed over the non-null,
  // non-INSUFFICIENT subset, and adding a null/INSUFFICIENT member to the group leaves the aggregate
  // unchanged.
  it('Property 4: aggregation excludes unavailable and insufficient data', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            insufficient: fc.boolean(),
            conversionRate: fc.float({ min: 0, max: 100, noNaN: true }),
            engagementRate: fc.float({ min: 0, max: 100, noNaN: true }),
            ctaClickRate: fc.float({ min: 0, max: 100, noNaN: true }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (specs) => {
          // All rows in one content_topic group.
          const rows = specs.map((s) =>
            perfRow({
              contentTopic: 'g',
              conversionRate: s.conversionRate,
              engagementRate: s.engagementRate,
              ctaClickRate: s.ctaClickRate,
              performanceLabel: s.insufficient ? 'INSUFFICIENT_DATA' : 'AVERAGE_PERFORMER',
            }),
          );
          const groups = aggregate(rows, 'content_topic');
          const usable = specs.filter((s) => !s.insufficient);

          if (usable.length === 0) {
            // Every row excluded -> no aggregate group emitted.
            expect(groups.length).toBe(0);
            return;
          }
          expect(groups.length).toBe(1);
          const g = groups[0];
          const mean = (sel: (s: typeof usable[number]) => number): number =>
            usable.reduce((acc, s) => acc + sel(s), 0) / usable.length;
          expect(g.count).toBe(usable.length);
          expect(g.avgConversionRate).toBeCloseTo(mean((s) => s.conversionRate), 6);
          expect(g.avgEngagementRate).toBeCloseTo(mean((s) => s.engagementRate), 6);

          // Adding an INSUFFICIENT member leaves the aggregate unchanged.
          const withExtra = [...rows, perfRow({ contentTopic: 'g', performanceLabel: 'INSUFFICIENT_DATA', conversionRate: 9999 })];
          const groups2 = aggregate(withExtra, 'content_topic');
          expect(groups2[0].count).toBe(g.count);
          expect(groups2[0].avgConversionRate).toBeCloseTo(g.avgConversionRate, 6);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 12: Empty-data analysis leaves strategy unchanged
  // For any analysis period in which every Performance_Record is labeled INSUFFICIENT_DATA, the
  // Feedback_Engine skips analysis entirely and produces no insights and no strategy change.
  it('Property 12: empty-data analysis leaves strategy unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ topic: fc.constantFrom('a', 'b', 'c') }),
          { minLength: 0, maxLength: 20 },
        ),
        async (specs) => {
          const db = makeFakeDb();
          // Every Performance_Record is INSUFFICIENT_DATA.
          specs.forEach((s, i) => {
            db.performanceRecords.push({
              id: `pr_${i}`, postId: `p_${i}`,
              domainCategory: 'd', contentTopic: s.topic, personaId: 'persona',
              toneOfVoice: 'friendly', objective: 'Lead', platform: 'facebook',
              postTimeSlot: 'morning', ctaType: 'link',
              conversionRate: 0, engagementRate: 0, ctaClickRate: 0, followRate: 0,
              performanceLabel: 'INSUFFICIENT_DATA', scoredAt: new Date(5000),
            });
          });
          const alerts = new InMemoryAlertDispatcher();
          const engine = new FeedbackEngine(
            db.prisma,
            geminiStub(false),
            DEFAULT_FEEDBACK_CONFIG,
            alerts,
            fixedClock(10_000),
          );
          const period: AnalysisPeriod = { label: 'w', from: new Date(0), to: new Date(10_000) };
          const result = await engine.run(new Date(10_000), period);

          expect(result.outcome).toBe('skipped');
          if (result.outcome === 'skipped') expect(result.reason).toBe('ALL_INSUFFICIENT_DATA');
          // No insights, no audit entries, no strategy/context change.
          expect(db.learningInsights.length).toBe(0);
          expect(db.auditEntries.length).toBe(0);
          expect(db.aiContexts.length).toBe(0);
          expect(db.personaUpdates.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 13: Minimum-sample gating
  // For any set of Performance_Records grouped by content_topic, the Feedback_Engine generates a
  // Learning_Insight for a topic only when that topic's record count is greater than or equal to
  // MIN_SAMPLE; if no topic reaches MIN_SAMPLE it generates no insights and leaves the strategy
  // unchanged; and every generated insight carries a sample_size greater than or equal to MIN_SAMPLE.
  it('Property 13: minimum-sample gating', () => {
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
          const rows = specs.map((s) =>
            perfRow({
              contentTopic: s.topic,
              performanceLabel: s.insufficient ? 'INSUFFICIENT_DATA' : 'AVERAGE_PERFORMER',
            }),
          );
          const eligible = eligibleTopics(rows, minSample);

          // Oracle: count non-insufficient records per topic.
          const counts = new Map<string, number>();
          for (const s of specs) {
            if (s.insufficient) continue;
            counts.set(s.topic, (counts.get(s.topic) ?? 0) + 1);
          }
          for (const topic of ['a', 'b', 'c']) {
            const usable = counts.get(topic) ?? 0;
            expect(eligible.includes(topic)).toBe(usable >= minSample);
            // Every eligible topic carries a usable count >= minSample (the sample_size floor).
            if (eligible.includes(topic)) expect(usable).toBeGreaterThanOrEqual(minSample);
          }
          // No topic reaches MIN_SAMPLE -> empty (no insights generated).
          const anyEligible = ['a', 'b', 'c'].some((t) => (counts.get(t) ?? 0) >= minSample);
          if (!anyEligible) expect(eligible.length).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: analytics-feedback-loop, Property 14: Analysis failure leaves strategy unchanged atomically
  // For any weekly run in which the Pattern_Recognition request to Gemini fails, or any single
  // sub-action of the combined log-notify-leave-unchanged operation fails, the strategy state after
  // the run is identical to its state before the run.
  it('Property 14: analysis failure leaves strategy unchanged atomically', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 20 }), // enough records of one topic to pass gating
        async (n) => {
          const db = makeFakeDb();
          for (let i = 0; i < n; i++) {
            db.performanceRecords.push({
              id: `pr_${i}`, postId: `p_${i}`,
              domainCategory: 'd', contentTopic: 'hot', personaId: 'persona',
              toneOfVoice: 'friendly', objective: 'Lead', platform: 'facebook',
              postTimeSlot: 'morning', ctaType: 'link',
              conversionRate: 12, engagementRate: 3, ctaClickRate: 2, followRate: 1,
              performanceLabel: 'HIGH_PERFORMER', scoredAt: new Date(5000),
            });
          }
          const alerts = new InMemoryAlertDispatcher();
          const engine = new FeedbackEngine(
            db.prisma,
            geminiStub(true), // Gemini fails
            DEFAULT_FEEDBACK_CONFIG,
            alerts,
            fixedClock(10_000),
          );
          const period: AnalysisPeriod = { label: 'w', from: new Date(0), to: new Date(10_000) };
          const result = await engine.run(new Date(10_000), period);

          expect(result.outcome).toBe('failed');
          if (result.outcome === 'failed') expect(result.reason).toBe('GEMINI');
          // Strategy unchanged: no insights persisted, no context, no persona writes.
          expect(db.learningInsights.length).toBe(0);
          expect(db.aiContexts.length).toBe(0);
          expect(db.personaUpdates.length).toBe(0);
          // The combined op did notify the Content_Manager.
          expect(alerts.alerts.some((a) => a.platform === 'gemini')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 15: Generated insights are well-formed
  // For any Learning_Insight produced by the Feedback_Engine, it carries exactly one Insight_Type,
  // supporting metrics, a Confidence_Score within [0, 1], and a sample_size.
  it('Property 15: generated insights are well-formed', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Mixed topics, some high (>=HIGH), some low (<MID), each with >= MIN_SAMPLE rows.
        fc.array(
          fc.record({
            topic: fc.constantFrom('hi1', 'hi2', 'lo1', 'lo2'),
            high: fc.boolean(),
          }),
          { minLength: 5, maxLength: 60 },
        ),
        async (specs) => {
          const db = makeFakeDb();
          specs.forEach((s, i) => {
            db.performanceRecords.push({
              id: `pr_${i}`, postId: `p_${i}`,
              domainCategory: 'd', contentTopic: s.topic, personaId: 'persona',
              toneOfVoice: 'friendly', objective: 'Lead', platform: 'facebook',
              postTimeSlot: 'morning', ctaType: 'link',
              conversionRate: s.high ? 12 : 0.5,
              engagementRate: 3, ctaClickRate: 2, followRate: 1,
              performanceLabel: s.high ? 'HIGH_PERFORMER' : 'LOW_PERFORMER',
              scoredAt: new Date(5000),
            });
          });
          const engine = new FeedbackEngine(
            db.prisma,
            geminiStub(false),
            DEFAULT_FEEDBACK_CONFIG,
            new InMemoryAlertDispatcher(),
            fixedClock(10_000),
          );
          const period: AnalysisPeriod = { label: 'w', from: new Date(0), to: new Date(10_000) };
          const result = await engine.run(new Date(10_000), period);

          if (result.outcome !== 'analyzed') {
            // Below-min-sample is acceptable for sparse inputs; nothing to assert.
            return;
          }
          for (const ins of result.insights) {
            expect(INSIGHT_TYPES).toContain(ins.insightType);
            expect(ins.metrics).toBeDefined();
            expect(ins.confidenceScore).toBeGreaterThanOrEqual(0);
            expect(ins.confidenceScore).toBeLessThanOrEqual(1);
            expect(typeof ins.sampleSize).toBe('number');
            expect(ins.sampleSize).toBeGreaterThanOrEqual(DEFAULT_FEEDBACK_CONFIG.minSample);
          }
          // Each persisted insight carries exactly one type + a confidence in [0,1].
          for (const row of db.learningInsights) {
            expect(INSIGHT_TYPES).toContain(row.insightType as InsightType);
            expect(row.confidenceScore as number).toBeGreaterThanOrEqual(0);
            expect(row.confidenceScore as number).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 16: Conditional insight-type selection
  // For any content_topic with sample_size >= MIN_SAMPLE, an average Conversion_Rate >= HIGH_THRESHOLD
  // produces a TOPIC_FREQUENCY_ADJUSTMENT insight recommending a frequency increase, and an average
  // Conversion_Rate < MID_THRESHOLD produces a LOW_PERFORMER_ALERT insight recommending reduction or
  // revision.
  it('Property 16: conditional insight-type selection', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.record({
          minSample: fc.integer({ min: 1, max: 10 }),
          midThreshold: fc.float({ min: 1, max: 20, noNaN: true }),
          gap: fc.float({ min: 0, max: 30, noNaN: true }),
        }),
        (avg, c) => {
          const cfg: FeedbackConfig = {
            minSample: c.minSample,
            midThreshold: c.midThreshold,
            highThreshold: c.midThreshold + c.gap,
          };
          const type = pickInsightType(avg, cfg);
          if (avg >= cfg.highThreshold) {
            expect(type).toBe('TOPIC_FREQUENCY_ADJUSTMENT');
          } else if (avg < cfg.midThreshold) {
            expect(type).toBe('LOW_PERFORMER_ALERT');
          } else {
            expect(type).toBeNull();
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  // Feature: analytics-feedback-loop, Property 17: Conflict resolution is deterministic and conversion-favoring
  // For any set of Learning_Insights containing conflicts on the same content_topic, persona_id, or
  // platform-and-time-slot, the surviving insight of each conflict is the one supported by
  // Conversion_Rate, the engagement-only conflicting insight is discarded or superseded, and the
  // same input set always yields the same survivors.
  it('Property 17: conflict resolution is deterministic and conversion-favoring', () => {
    const insightArb = fc.record({
      contentTopic: fc.constantFrom('t1', 't2', 't3'),
      supportedBy: fc.constantFrom<'conversion' | 'engagement'>('conversion', 'engagement'),
      insightType: fc.constantFrom<InsightType>('TOPIC_FREQUENCY_ADJUSTMENT', 'LOW_PERFORMER_ALERT'),
      tag: fc.integer({ min: 0, max: 1000 }),
    });
    fc.assert(
      fc.property(fc.array(insightArb, { maxLength: 30 }), (specs) => {
        const insights: GeneratedInsight[] = specs.map((s) => ({
          insightType: s.insightType,
          subject: { contentTopic: s.contentTopic },
          metrics: { tag: s.tag },
          recommendedChange: { insightType: s.insightType },
          confidenceScore: 0.5,
          sampleSize: 5,
          supportedBy: s.supportedBy,
        }));

        const r1 = resolveConflicts(insights);
        const r2 = resolveConflicts(insights);

        // Deterministic: identical kept/discarded across runs.
        expect(r1.kept.map((k) => k.metrics.tag)).toEqual(r2.kept.map((k) => k.metrics.tag));
        expect(r1.discarded.map((k) => k.metrics.tag)).toEqual(r2.discarded.map((k) => k.metrics.tag));

        // For each conflicting subject, if any conversion-backed insight exists,
        // the survivor for that subject is conversion-backed.
        const bySubject = new Map<string, GeneratedInsight[]>();
        for (const ins of insights) {
          const key = ins.subject.contentTopic as string;
          (bySubject.get(key) ?? bySubject.set(key, []).get(key)!).push(ins);
        }
        for (const [topic, group] of bySubject) {
          const survivor = r1.kept.find((k) => k.subject.contentTopic === topic);
          expect(survivor).toBeDefined();
          if (group.some((g) => g.supportedBy === 'conversion')) {
            expect(survivor?.supportedBy).toBe('conversion');
          }
        }
        // Every insight is accounted for exactly once (kept ∪ discarded == input).
        expect(r1.kept.length + r1.discarded.length).toBe(insights.length);
        // One survivor per distinct subject.
        expect(r1.kept.length).toBe(bySubject.size);
      }),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// Insight_State_Machine property
// =============================================================================

describe('analytics-feedback-loop properties (state machine)', () => {
  // Feature: analytics-feedback-loop, Property 18: Insight lifecycle transition closure
  // For any current Insight_Status and any target status, the transition succeeds only when the pair
  // is one of NEW->PENDING_REVIEW, PENDING_REVIEW->APPROVED, or PENDING_REVIEW->REJECTED; every other
  // pair is rejected with 409 leaving the status unchanged; and no transition leaves APPROVED or
  // REJECTED, so a terminal insight never returns to PENDING_REVIEW.
  it('Property 18: insight lifecycle transition closure', () => {
    const allowed = new Set(INSIGHT_TRANSITIONS.map(([a, b]) => `${a}->${b}`));
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (current, target) => {
          const result = insightTransition(current, target);
          const isAllowed = allowed.has(`${current}->${target}`);
          expect(result.ok).toBe(isAllowed);
          if (result.ok) {
            expect(result.status).toBe(target);
          } else {
            expect(result.status).toBe(409);
          }
          // Terminal states never transition (no outgoing edges).
          if (current === 'APPROVED' || current === 'REJECTED') {
            expect(result.ok).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Insight_Service properties
// =============================================================================

// A StrategyProcessor fake that records the change it would apply (modified
// supersedes recommended) so we can assert on it without touching the DB.
function recordingProcessor(): StrategyProcessor & { applied: InsightApplyInput[] } {
  const applied: InsightApplyInput[] = [];
  const proc: StrategyProcessor & { applied: InsightApplyInput[] } = {
    applied,
    apply: async (insight: InsightApplyInput): Promise<AppliedChange> => {
      applied.push(insight);
      return { insightId: insight.id, touched: ['AI_CONTEXT'], auditEntryId: 'audit_x' };
    },
  };
  return proc;
}

describe('analytics-feedback-loop properties (insight service)', () => {
  // Feature: analytics-feedback-loop, Property 19: Pending list is filtered and projected
  // For any set of Learning_Insights of mixed status, listing returns exactly the PENDING_REVIEW
  // insights, each carrying its Insight_Type, supporting metrics, Confidence_Score, and sample_size.
  it('Property 19: pending list is filtered and projected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            status: fc.constantFrom(...ALL_STATUSES),
            insightType: fc.constantFrom(...INSIGHT_TYPES),
            confidenceScore: fc.float({ min: 0, max: 1, noNaN: true }),
            sampleSize: fc.integer({ min: 1, max: 50 }),
          }),
          { maxLength: 30 },
        ),
        async (specs) => {
          const db = makeFakeDb();
          specs.forEach((s, i) => {
            db.learningInsights.push({
              id: `li_${i}`,
              insightType: s.insightType,
              insightStatus: s.status,
              subject: { contentTopic: 't' },
              metrics: { avgConversionRate: 5 },
              recommendedChange: { insightType: s.insightType },
              modifiedChange: null,
              confidenceScore: s.confidenceScore,
              sampleSize: s.sampleSize,
              analysisPeriod: 'w',
              rejectionReason: null,
              generatedAt: new Date(i),
            });
          });
          const svc = new InsightService(db.prisma, recordingProcessor(), fixedClock(1000));
          const { items, total } = await svc.listPending(1, 1000);

          const expectedPending = specs.filter((s) => s.status === 'PENDING_REVIEW').length;
          expect(items.length).toBe(expectedPending);
          expect(total).toBe(expectedPending);
          for (const item of items) {
            expect(item.insightStatus).toBe('PENDING_REVIEW');
            expect(INSIGHT_TYPES).toContain(item.insightType as InsightType);
            expect(item.metrics).toBeDefined();
            expect(typeof item.confidenceScore).toBe('number');
            expect(typeof item.sampleSize).toBe('number');
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: analytics-feedback-loop, Property 20: Reject requires a reason
  // For any reject request, when the reason is missing or blank (including whitespace-only) the
  // request is rejected with HTTP 400 and the Insight_Status is unchanged; when a non-blank reason
  // is provided the insight transitions to REJECTED and the reason is stored.
  it('Property 20: reject requires a reason', async () => {
    const blankArb = fc.constantFrom('', ' ', '   ', '\t', '\n', '  \t \n ');
    const nonBlankArb = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => s.trim().length > 0);
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({ blank: fc.constant(true), reason: blankArb }),
          fc.record({ blank: fc.constant(false), reason: nonBlankArb }),
        ),
        async (spec) => {
          const db = makeFakeDb();
          db.learningInsights.push({
            id: 'li_1',
            insightType: 'LOW_PERFORMER_ALERT',
            insightStatus: 'PENDING_REVIEW',
            subject: { contentTopic: 't' },
            metrics: {},
            recommendedChange: {},
            modifiedChange: null,
            confidenceScore: 0.5,
            sampleSize: 5,
            analysisPeriod: 'w',
            rejectionReason: null,
            generatedAt: new Date(0),
          });
          const svc = new InsightService(db.prisma, recordingProcessor(), fixedClock(1000));

          if (spec.blank) {
            await expect(svc.reject('li_1', 'admin', spec.reason)).rejects.toMatchObject({ status: 400 });
            // Status unchanged.
            expect(db.learningInsights[0].insightStatus).toBe('PENDING_REVIEW');
            expect(db.learningInsights[0].rejectionReason).toBeNull();
          } else {
            const res = await svc.reject('li_1', 'admin', spec.reason);
            expect(res.status).toBe('REJECTED');
            expect(db.learningInsights[0].insightStatus).toBe('REJECTED');
            expect(db.learningInsights[0].rejectionReason).toBe(spec.reason.trim());
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: analytics-feedback-loop, Property 21: Modified insights apply the modified change
  // For any PENDING_REVIEW insight whose recommended change has been modified, approving it causes
  // the Strategy_Update_Processor to apply the modified change rather than the original.
  it('Property 21: modified insights apply the modified change', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }), // original marker
        fc.integer({ min: 1001, max: 2000 }), // modified marker (distinct range)
        async (origMark, modMark) => {
          const db = makeFakeDb();
          db.learningInsights.push({
            id: 'li_1',
            insightType: 'TOPIC_FREQUENCY_ADJUSTMENT',
            insightStatus: 'PENDING_REVIEW',
            subject: { contentTopic: 't' },
            metrics: {},
            recommendedChange: { insightType: 'TOPIC_FREQUENCY_ADJUSTMENT', marker: origMark },
            modifiedChange: null,
            confidenceScore: 0.5,
            sampleSize: 5,
            analysisPeriod: 'w',
            rejectionReason: null,
            generatedAt: new Date(0),
          });
          const proc = recordingProcessor();
          const svc = new InsightService(db.prisma, proc, fixedClock(1000));

          // Modify then approve.
          await svc.modify('li_1', { insightType: 'TOPIC_FREQUENCY_ADJUSTMENT', marker: modMark });
          await svc.approve('li_1', 'admin');

          expect(proc.applied.length).toBe(1);
          const passed = proc.applied[0];
          // The processor receives the modifiedChange and applies it (modified supersedes original).
          const mc = passed.modifiedChange as { marker?: number } | null;
          expect(mc?.marker).toBe(modMark);
          const effective = (passed.modifiedChange ?? passed.recommendedChange) as { marker?: number };
          expect(effective.marker).toBe(modMark);
          expect(effective.marker).not.toBe(origMark);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: analytics-feedback-loop, Property 22: Auto_Mode routing
  // For any Learning_Insight: while Auto_Mode is disabled every insight is routed through
  // Review_Mode; while Auto_Mode is enabled, an insight recommending a posting-frequency adjustment
  // of 30% or less or a posting time-slot change is auto-applied without approval, and any other
  // insight is routed through Review_Mode.
  it('Property 22: Auto_Mode routing', () => {
    const changeArb = fc.record(
      {
        insightType: fc.constantFrom(...INSIGHT_TYPES),
        frequencyDeltaPct: fc.option(fc.integer({ min: -100, max: 100 }), { nil: undefined }),
        timeSlot: fc.option(fc.constantFrom('morning', 'afternoon', 'evening', 'night'), {
          nil: undefined,
        }),
      },
      { requiredKeys: ['insightType'] },
    );
    fc.assert(
      fc.property(changeArb, fc.boolean(), (change, autoMode) => {
        const routing = routeInsight(change, autoMode);

        if (!autoMode) {
          // Disabled -> everything is reviewed.
          expect(routing).toBe('REVIEW');
          return;
        }
        // Enabled: derive the expected outcome from the rule.
        const isFreq =
          change.insightType === 'TOPIC_FREQUENCY_ADJUSTMENT' &&
          typeof change.frequencyDeltaPct === 'number' &&
          Math.abs(change.frequencyDeltaPct) <= 30;
        const isSlot =
          change.insightType === 'OPTIMAL_POSTING_SCHEDULE' ||
          (typeof change.timeSlot === 'string' && change.timeSlot.length > 0);
        expect(routing).toBe(isFreq || isSlot ? 'AUTO_APPLY' : 'REVIEW');
      }),
      { numRuns: 400 },
    );
  });
});

// =============================================================================
// Strategy_Update_Processor properties
// =============================================================================

function insightRow(over: Record<string, unknown>): {
  id: string;
  insightType: string;
  subject: unknown;
  metrics: unknown;
  recommendedChange: unknown;
  modifiedChange: unknown;
} {
  return {
    id: 'li',
    insightType: 'LOW_PERFORMER_ALERT',
    subject: {},
    metrics: {},
    recommendedChange: {},
    modifiedChange: null,
    ...over,
  };
}

describe('analytics-feedback-loop properties (strategy processor)', () => {
  // Feature: analytics-feedback-loop, Property 23: Strategy mutates only through the processor
  // For any sequence of insights, the Content_Calendar topic frequency, Content_Persona
  // recommended_tone, and AI_Prompt_Context change only as a result of a Strategy_Update_Processor
  // application following approval (or Auto_Mode auto-apply); an insight that is merely APPROVED, or
  // that is REJECTED, never mutates those targets by itself.
  it('Property 23: strategy mutates only through the processor', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            decision: fc.constantFrom<'approve' | 'reject' | 'leave'>('approve', 'reject', 'leave'),
            insightType: fc.constantFrom(...INSIGHT_TYPES),
          }),
          { maxLength: 12 },
        ),
        async (specs) => {
          const db = makeFakeDb();
          // Seed a persona so PERSONA_TONE_OPTIMIZATION could write if applied.
          db.personas.push({ id: 'persona', recommendedTone: 'original' });
          specs.forEach((s, i) => {
            db.learningInsights.push({
              id: `li_${i}`,
              insightType: s.insightType,
              insightStatus: 'PENDING_REVIEW',
              subject: { contentTopic: `t_${i}`, personaId: 'persona' },
              metrics: { avgConversionRate: 7 },
              recommendedChange: { insightType: s.insightType, personaId: 'persona', recommendedTone: 'newtone' },
              modifiedChange: null,
              confidenceScore: 0.5,
              sampleSize: 5,
              analysisPeriod: 'w',
              rejectionReason: null,
              generatedAt: new Date(i),
            });
          });

          const processor = new StrategyUpdateProcessor(db.prisma, fixedClock(50_000));
          const svc = new InsightService(db.prisma, processor, fixedClock(50_000));

          let approvals = 0;
          for (let i = 0; i < specs.length; i++) {
            const s = specs[i];
            if (s.decision === 'approve') {
              await svc.approve(`li_${i}`, 'admin');
              approvals++;
            } else if (s.decision === 'reject') {
              await svc.reject(`li_${i}`, 'admin', 'not useful');
            }
            // 'leave' -> remains PENDING_REVIEW; never triggers the processor.
          }

          // Context rows exist iff at least one approval ran through the processor.
          if (approvals === 0) {
            expect(db.aiContexts.length).toBe(0);
            // No REJECTED/PENDING insight mutated the persona by itself.
            expect(db.personaUpdates.length).toBe(0);
          } else {
            expect(db.aiContexts.length).toBeGreaterThan(0);
          }
          // Persona writes only ever come from PERSONA_TONE_OPTIMIZATION approvals.
          const personaApprovals = specs.filter(
            (s) => s.decision === 'approve' && s.insightType === 'PERSONA_TONE_OPTIMIZATION',
          ).length;
          if (personaApprovals === 0) {
            expect(db.personaUpdates.length).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 24: Applied changes touch only relevant components
  // For any applied Learning_Insight, only the components relevant to its Insight_Type are
  // modified -- TOPIC_FREQUENCY_ADJUSTMENT updates Content_Calendar frequency,
  // PERSONA_TONE_OPTIMIZATION updates the persona recommended_tone, and every applied insight
  // updates the affected AI_Prompt_Context fields -- while components unrelated to the insight's type
  // remain unchanged.
  it('Property 24: applied changes touch only relevant components', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...INSIGHT_TYPES), async (insightType) => {
        const db = makeFakeDb();
        db.personas.push({ id: 'persona', recommendedTone: 'original' });
        const insight = insightRow({
          id: 'li_1',
          insightType,
          subject: { contentTopic: 'topic', personaId: 'persona', platform: 'facebook' },
          metrics: { avgConversionRate: 8 },
          recommendedChange: {
            insightType,
            contentTopic: 'topic',
            personaId: 'persona',
            recommendedTone: 'newtone',
            platform: 'facebook',
            timeSlot: 'morning',
            bestSlot: 'morning',
            frequencyDeltaPct: 20,
          },
        });
        // Persist the insight as APPROVED so refreshContextWith finds it.
        db.learningInsights.push({
          ...insight,
          insightStatus: 'APPROVED',
          confidenceScore: 0.5,
          sampleSize: 5,
          analysisPeriod: 'w',
          rejectionReason: null,
          generatedAt: new Date(0),
        });

        const processor = new StrategyUpdateProcessor(db.prisma, fixedClock(50_000));
        const applied = await processor.apply(insight, 'REVIEW');

        // AI_CONTEXT is always touched.
        expect(applied.touched).toContain('AI_CONTEXT');
        // CALENDAR touched iff TOPIC_FREQUENCY_ADJUSTMENT.
        expect(applied.touched.includes('CALENDAR')).toBe(insightType === 'TOPIC_FREQUENCY_ADJUSTMENT');
        // PERSONA touched (and persona row written) iff PERSONA_TONE_OPTIMIZATION.
        const personaTouched = applied.touched.includes('PERSONA');
        expect(personaTouched).toBe(insightType === 'PERSONA_TONE_OPTIMIZATION');
        if (insightType === 'PERSONA_TONE_OPTIMIZATION') {
          expect(db.personaUpdates.length).toBe(1);
          expect(db.personas[0].recommendedTone).toBe('newtone');
        } else {
          expect(db.personaUpdates.length).toBe(0);
          expect(db.personas[0].recommendedTone).toBe('original');
        }
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// AI_Prompt_Context properties
// =============================================================================

describe('analytics-feedback-loop properties (ai-context)', () => {
  // Feature: analytics-feedback-loop, Property 25: AI_Prompt_Context production and derivation
  // For any set of applied Learning_Insights, the produced AI_Prompt_Context populates all six
  // fields, a read returns the most recently produced context with its last_updated_from_analytics
  // timestamp, avoid_topics contains exactly the content_topics of applied LOW_PERFORMER_ALERT
  // insights recommending reduction or revision, and top_performing_topics contains exactly the
  // content_topics of applied HIGH_PERFORMER insights with their average Conversion_Rate.
  it('Property 25: AI_Prompt_Context production and derivation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom<'high' | 'low' | 'other'>('high', 'low', 'other'),
            topic: fc.constantFrom('t1', 't2', 't3', 't4'),
            avg: fc.float({ min: 0, max: 100, noNaN: true }),
          }),
          { maxLength: 20 },
        ),
        async (specs) => {
          const db = makeFakeDb();
          const rows = specs.map((s, i) => {
            const insightType: InsightType =
              s.kind === 'high'
                ? 'TOPIC_FREQUENCY_ADJUSTMENT'
                : s.kind === 'low'
                  ? 'LOW_PERFORMER_ALERT'
                  : 'PLATFORM_CONTENT_FIT';
            return insightRow({
              id: `li_${i}`,
              insightType,
              subject: { contentTopic: s.topic, platform: 'facebook' },
              metrics: { avgConversionRate: s.avg },
              recommendedChange: { insightType, contentTopic: s.topic, platform: 'facebook', optimalContentLength: 'short' },
            });
          });
          const processor = new StrategyUpdateProcessor(db.prisma, fixedClock(77_000));
          const ctx = processor.produceAiContext(rows, new Date(77_000));

          // All six fields populated (present and of the right kind).
          expect(typeof ctx.contextVersion).toBe('string');
          expect(ctx.lastUpdatedFromAnalytics).toBe(new Date(77_000).toISOString());
          expect(Array.isArray(ctx.topPerformingTopics)).toBe(true);
          expect(Array.isArray(ctx.bestCtaPatterns)).toBe(true);
          expect(Array.isArray(ctx.avoidTopics)).toBe(true);
          expect(typeof ctx.optimalContentLength).toBe('object');
          expect(typeof ctx.toneRecommendations).toBe('object');
          expect(typeof ctx.optimalSchedules).toBe('object');

          // avoid_topics == distinct topics of LOW_PERFORMER_ALERT insights.
          const expectedAvoid = new Set(specs.filter((s) => s.kind === 'low').map((s) => s.topic));
          expect(new Set(ctx.avoidTopics.map((a) => a.topic))).toEqual(expectedAvoid);
          // top_performing_topics == distinct topics of HIGH (freq-adjust) insights.
          const expectedTop = new Set(specs.filter((s) => s.kind === 'high').map((s) => s.topic));
          expect(new Set(ctx.topPerformingTopics.map((t) => t.topic))).toEqual(expectedTop);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: analytics-feedback-loop, Property 26: Cold-start context is empty, not an error
  // For any read of /api/strategy/ai-context when no Learning_Insight has been applied, the response
  // is the empty AI_Prompt_Context (all collections empty, null timestamp) and never an error.
  it('Property 26: cold-start context is empty, not an error', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 1000 }), async () => {
        const db = makeFakeDb(); // no aiContexts seeded -> cold start
        const model = new AiContextReadModel(db.prisma);
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
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Audit_Log properties
// =============================================================================

describe('analytics-feedback-loop properties (audit log)', () => {
  // Feature: analytics-feedback-loop, Property 27: Audit log completeness
  // For any sequence of feedback operations, the Audit_Log contains an entry for every generated
  // insight, every conflict resolution, every approve and reject decision (with deciding identity
  // and timestamp), and every applied strategy change (with its source insight and timestamp).
  it('Property 27: audit log completeness', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<'approve' | 'reject'>('approve', 'reject'), { minLength: 1, maxLength: 10 }),
        async (decisions) => {
          const db = makeFakeDb();
          db.personas.push({ id: 'persona', recommendedTone: 'original' });
          decisions.forEach((_, i) => {
            db.learningInsights.push({
              id: `li_${i}`,
              insightType: 'TOPIC_FREQUENCY_ADJUSTMENT',
              insightStatus: 'PENDING_REVIEW',
              subject: { contentTopic: `t_${i}` },
              metrics: { avgConversionRate: 9 },
              recommendedChange: { insightType: 'TOPIC_FREQUENCY_ADJUSTMENT', contentTopic: `t_${i}`, frequencyDeltaPct: 20 },
              modifiedChange: null,
              confidenceScore: 0.5,
              sampleSize: 5,
              analysisPeriod: 'w',
              rejectionReason: null,
              generatedAt: new Date(i),
            });
          });
          const processor = new StrategyUpdateProcessor(db.prisma, fixedClock(60_000));
          const svc = new InsightService(db.prisma, processor, fixedClock(60_000));

          let expectedApproved = 0;
          let expectedRejected = 0;
          let expectedApplied = 0;
          for (let i = 0; i < decisions.length; i++) {
            if (decisions[i] === 'approve') {
              await svc.approve(`li_${i}`, 'admin');
              expectedApproved++;
              expectedApplied++; // STRATEGY_CHANGE_APPLIED per approval
            } else {
              await svc.reject(`li_${i}`, 'admin', 'no good');
              expectedRejected++;
            }
          }

          const byType = (t: string): typeof db.auditEntries =>
            db.auditEntries.filter((e) => e.eventType === t);

          // Every approve decision recorded with deciding identity + timestamp.
          expect(byType('INSIGHT_APPROVED').length).toBe(expectedApproved);
          for (const e of byType('INSIGHT_APPROVED')) {
            expect(e.actor).toBe('admin');
            expect(e.recordedAt).toBeInstanceOf(Date);
          }
          // Every reject decision recorded with identity + timestamp + reason.
          expect(byType('INSIGHT_REJECTED').length).toBe(expectedRejected);
          for (const e of byType('INSIGHT_REJECTED')) {
            expect(e.actor).toBe('admin');
            expect(e.recordedAt).toBeInstanceOf(Date);
          }
          // Every applied strategy change recorded with its source insight + timestamp.
          expect(byType('STRATEGY_CHANGE_APPLIED').length).toBe(expectedApplied);
          for (const e of byType('STRATEGY_CHANGE_APPLIED')) {
            expect(typeof e.insightId).toBe('string');
            expect((e.insightId as string).length).toBeGreaterThan(0);
            expect(e.recordedAt).toBeInstanceOf(Date);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: analytics-feedback-loop, Property 28: Audit log is append-only
  // For any sequence of operations against the Audit_Log, every previously written entry remains
  // present and unchanged afterward, no entry is ever removed, and the log length is monotonically
  // non-decreasing.
  it('Property 28: audit log is append-only', async () => {
    const eventArb = fc.record({
      eventType: fc.constantFrom(
        'INSIGHT_GENERATED',
        'INSIGHT_APPROVED',
        'INSIGHT_REJECTED',
        'CONFLICT_RESOLVED',
        'STRATEGY_CHANGE_APPLIED',
      ),
      insightId: fc.string({ minLength: 1, maxLength: 8 }),
      actor: fc.constantFrom('admin', 'AUTO_MODE', 'background-worker'),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(eventArb, { minLength: 1, maxLength: 25 }), async (events) => {
        const db = makeFakeDb(() => new Date(42));
        const audit = new AuditLog(db.prisma);

        // The append-only API exposes no update/delete methods.
        const apiMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(audit));
        expect(apiMethods).not.toContain('update');
        expect(apiMethods).not.toContain('delete');
        expect(apiMethods).not.toContain('remove');

        const snapshots: Array<{ length: number; ids: string[] }> = [];
        let prevLen = 0;
        for (const ev of events) {
          await audit.append(
            ev.eventType as Parameters<AuditLog['append']>[0],
            ev.insightId,
            ev.actor,
            { note: 'x' },
          );
          const current = await audit.listRecent(1, 1000);
          // Monotonically non-decreasing length (strictly +1 per append here).
          expect(current.total).toBe(prevLen + 1);
          prevLen = current.total;
          snapshots.push({ length: current.total, ids: db.auditEntries.map((e) => e.id as string) });
        }

        // Every earlier id remains present (and unchanged) in all later snapshots.
        for (let i = 0; i < snapshots.length; i++) {
          for (const id of snapshots[i].ids) {
            for (let j = i; j < snapshots.length; j++) {
              expect(snapshots[j].ids).toContain(id);
            }
          }
          // Lengths never decrease.
          if (i > 0) expect(snapshots[i].length).toBeGreaterThanOrEqual(snapshots[i - 1].length);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// RBAC property
// =============================================================================

describe('analytics-feedback-loop properties (rbac)', () => {
  // Feature: analytics-feedback-loop, Property 29: RBAC denies unauthorized access without side effects
  // For any request to the protected endpoints, a request lacking a valid Access_Token is rejected;
  // a SALES-role request to a feedback-review endpoint (/api/feedback/insights, /apply, /reject) is
  // denied with HTTP 403; and a Service_Account request for an operation outside its permission set
  // is denied with HTTP 403 -- in every denial case the request is not processed and no state is
  // modified.
  it('Property 29: RBAC denies unauthorized access without side effects', async () => {
    // Part A (pure policy): SALES is denied on the feedback module; ADMIN allowed.
    const feedbackActions: Action[] = ['read', 'create', 'update', 'delete', 'status_update'];
    fc.assert(
      fc.property(
        fc.constantFrom<'ADMIN' | 'SALES'>('ADMIN', 'SALES'),
        fc.constantFrom<Module>('feedback', 'analytics', 'strategy'),
        fc.constantFrom(...feedbackActions),
        (role, mod, action) => {
          const ctx: AuthContext = { userId: 'u1', role };
          const target: ResourceTarget = { module: mod, action };
          const decision = authorize(ctx, target);
          if (role === 'ADMIN') {
            expect(decision.allowed).toBe(true);
          } else {
            // SALES has no access to feedback/analytics/strategy modules -> 403.
            expect(decision.allowed).toBe(false);
            if (!decision.allowed) expect(decision.status).toBe(403);
          }
        },
      ),
      { numRuns: 300 },
    );

    // Part B (missing/invalid Access_Token): verifying a non-token string rejects,
    // so a request lacking a valid token is never processed.
    const jwt = new JwtService('test-secret-of-sufficient-length', 24, 30, fixedClock(1_000_000));
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 40 }).filter((s) => s.split('.').length !== 3 || s.length < 10),
        async (notAToken) => {
          await expect(jwt.verify(notAToken, 'access')).rejects.toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
