/**
 * Collection_Service (design Req 1, 2, 3, 4, 5).
 *
 * Scheduled metric collector. For each PUBLISHED Scheduled_Post that carries an
 * External_Post_Id it resolves the platform adapter(s), checks token validity
 * (refreshing on demand), collects the available subset of raw metrics, shapes
 * them into the canonical RawMetrics (Unavailable_Metrics stored as null — never
 * coerced to 0), matches by External_Post_Id, and persists an Analytics_Record.
 *
 * A per-platform request failure is isolated: it raises an alert, keeps the most
 * recent Analytics_Records (no overwrite), and collection continues for the rest.
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import type { AlertDispatcher } from '../infra/alerts';
import type { AdapterRegistry } from '../platforms/registry';
import type { PlatformId, AnalyticsResult } from '../platforms/adapter';
import type { Platform, RawMetrics } from './scoring';
import { asNumberOrNull, isRecord } from '../platforms/narrow';

/** Token-validity + on-demand refresh seam (Token_Manager implements this). */
export interface TokenGate {
  isValid(platform: string): Promise<boolean>;
  refresh(platform: string): Promise<unknown>;
}

interface PublishedPostRow {
  id: string;
  platform: string;
  externalPostId: string;
}

export interface PlatformCollectionOutcome {
  postId: string;
  platform: Platform;
  ok: boolean;
  reason?: string;
}

export interface CollectionReport {
  collectedAt: string;
  totalPosts: number;
  persisted: number;
  failures: Array<{ postId: string; platform: Platform; reason: string }>;
  outcomes: PlatformCollectionOutcome[];
}

/** Canonical RawMetrics keys we attempt to fill. */
const METRIC_KEYS = [
  'views',
  'likes',
  'shares',
  'comments',
  'follows',
  'leads',
  'clickThrough',
  'reach',
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * Candidate source keys per platform per canonical metric. The first key that
 * is PRESENT in the raw record wins; a present-but-non-numeric value becomes
 * null. If no candidate key is present the metric is null (Unavailable_Metric).
 */
const SOURCE_KEYS: Record<Platform, Record<MetricKey, readonly string[]>> = {
  facebook: {
    views: ['views', 'impressions'],
    likes: ['likes'],
    shares: ['shares'],
    comments: ['comments'],
    follows: ['follows'],
    leads: ['leads'],
    clickThrough: ['clickThrough', 'clicks', 'click_through'],
    reach: ['reach'],
  },
  tiktok: {
    views: ['views', 'view_count'],
    likes: ['likes', 'like_count'],
    shares: ['shares', 'share_count'],
    comments: ['comments', 'comment_count'],
    follows: ['follows'],
    leads: ['leads'],
    clickThrough: ['clickThrough', 'click_through'],
    reach: ['reach'],
  },
  website: {
    views: ['views', 'screenPageViews', 'pageviews'],
    likes: ['likes'],
    shares: ['shares'],
    comments: ['comments'],
    follows: ['follows'],
    leads: ['leads', 'conversions'],
    clickThrough: ['clickThrough', 'clicks'],
    reach: ['reach', 'sessions'],
  },
};

/** Adapter platform ids backing each Scheduled_Post platform. */
const ADAPTERS_FOR: Record<Platform, readonly PlatformId[]> = {
  facebook: ['facebook'],
  tiktok: ['tiktok'],
  website: ['custom_cms', 'ga4'],
};

function isPlatform(value: string): value is Platform {
  return value === 'facebook' || value === 'tiktok' || value === 'website';
}

export class CollectionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: AdapterRegistry,
    private readonly tokenManager: TokenGate,
    private readonly alerts: AlertDispatcher,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Run one Collection_Cycle: collect, shape, and persist metrics for every
   * PUBLISHED post with an External_Post_Id. Returns a per-post report.
   */
  async runCycle(now: Date = this.clock.now()): Promise<CollectionReport> {
    const rows = await this.prisma.scheduledPost.findMany({
      where: { status: 'PUBLISHED', externalPostId: { not: null } },
      orderBy: { updatedAt: 'desc' },
    });

    const posts: PublishedPostRow[] = rows
      .filter((r): r is typeof r & { externalPostId: string } => typeof r.externalPostId === 'string')
      .map((r) => ({ id: r.id, platform: r.platform, externalPostId: r.externalPostId }));

    const report: CollectionReport = {
      collectedAt: now.toISOString(),
      totalPosts: posts.length,
      persisted: 0,
      failures: [],
      outcomes: [],
    };

    for (const post of posts) {
      if (!isPlatform(post.platform)) {
        // Unknown platform: isolate and continue (no Analytics_Record created).
        report.outcomes.push({
          postId: post.id,
          platform: 'website',
          ok: false,
          reason: `unsupported platform "${post.platform}"`,
        });
        continue;
      }
      const platform = post.platform;

      try {
        const raw = await this.collectRaw(platform, post.externalPostId, now);
        const metrics = this.shapeMetrics(platform, raw);
        await this.persist(post.id, platform, metrics, now);
        report.persisted += 1;
        report.outcomes.push({ postId: post.id, platform, ok: true });
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'collection failed';
        // Req 4: isolate per-platform failure — alert, keep last data, continue.
        await this.alerts.raise('REFRESH_FAILURE', platform, `collection failed: ${reason}`);
        report.failures.push({ postId: post.id, platform, reason });
        report.outcomes.push({ postId: post.id, platform, ok: false, reason });
      }
    }

    return report;
  }

  /**
   * Resolve the internal Published_Post for an External_Post_Id, or null when no
   * post matches / matching fails (Req 2.1, 2.3).
   */
  async matchToPost(externalPostId: string): Promise<{ id: string; platform: string } | null> {
    if (!externalPostId) return null;
    const row = await this.prisma.scheduledPost.findFirst({
      where: { externalPostId, status: 'PUBLISHED' },
      select: { id: true, platform: true },
    });
    return row ?? null;
  }

  /**
   * Pure: shape a platform's raw metric payload into canonical RawMetrics.
   * TikTok forces reach=null and follows=null (Unavailable_Metrics, Req 3.3).
   * A metric whose source key is absent is null — never 0 (Req 3.4).
   */
  shapeMetrics(platform: Platform, raw: unknown): RawMetrics {
    const record = isRecord(raw) ? raw : {};
    const map = SOURCE_KEYS[platform];
    const out: RawMetrics = {};

    for (const key of METRIC_KEYS) {
      out[key] = readFirstPresent(record, map[key]);
    }

    if (platform === 'tiktok') {
      // TikTok exposes neither reach nor follows — force Unavailable_Metric.
      out.reach = null;
      out.follows = null;
    }

    return out;
  }

  // --- internals -------------------------------------------------------------

  /**
   * Collect the raw metric record for a post. Website merges the Custom CMS pass
   * with a GA4 pass (GA4 fills any gaps the CMS did not provide).
   */
  private async collectRaw(
    platform: Platform,
    externalPostId: string,
    now: Date,
  ): Promise<Record<string, number | null>> {
    const merged: Record<string, number | null> = {};
    for (const adapterId of ADAPTERS_FOR[platform]) {
      await this.ensureToken(adapterId);
      const adapter = this.registry.get(adapterId);
      const result: AnalyticsResult = await adapter.collectAnalytics({ externalPostId });
      mergeMetrics(merged, result.metrics);
    }
    // `now` is reserved for future windowed queries; referenced to keep the
    // collection timestamp authoritative at the call site.
    void now;
    return merged;
  }

  /** Token gate (Req 1.5): refresh when the platform token is invalid/expired. */
  private async ensureToken(adapterId: PlatformId): Promise<void> {
    const valid = await this.tokenManager.isValid(adapterId);
    if (!valid) {
      await this.tokenManager.refresh(adapterId);
    }
  }

  private async persist(
    postId: string,
    platform: Platform,
    metrics: RawMetrics,
    now: Date,
  ): Promise<void> {
    await this.prisma.analyticsRecord.create({
      data: {
        publishedPostId: postId,
        platform,
        views: metrics.views ?? null,
        likes: metrics.likes ?? null,
        shares: metrics.shares ?? null,
        comments: metrics.comments ?? null,
        follows: metrics.follows ?? null,
        leads: metrics.leads ?? null,
        clickThrough: metrics.clickThrough ?? null,
        reach: metrics.reach ?? null,
        collectedAt: now,
      },
    });
  }
}

/** First present source key wins; present-but-non-numeric -> null; absent -> null. */
function readFirstPresent(
  record: Record<string, unknown>,
  candidates: readonly string[],
): number | null {
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return asNumberOrNull(record[key]);
    }
  }
  return null;
}

/** Merge a metric record into the accumulator; only fill keys not already set. */
function mergeMetrics(
  target: Record<string, number | null>,
  source: Record<string, number | null>,
): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (existing === undefined || existing === null) {
      target[key] = value;
    }
  }
}
