/**
 * Scoring_Engine service wrapper (design Req 6, 7, 8, 9).
 *
 * Reuses the pure `computeRates` / `labelFor` from scoring.ts to turn an
 * Analytics_Record + Content_Features into a persisted Performance_Record.
 * Divide-by-zero safety and INSUFFICIENT_DATA exclusion are inherited from the
 * pure module. Re-scoring on recovery is supported via `scoreByPost`.
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import {
  computeRates,
  labelFor,
  DEFAULT_SCORING_CONFIG,
} from './scoring';
import type { Platform, RawMetrics, ScoringConfig, PerformanceLabel } from './scoring';
import type { ContentFeatures } from './types';

interface AnalyticsRecordInput {
  id?: string;
  publishedPostId: string;
  platform: string;
  views: number | null;
  likes: number | null;
  shares: number | null;
  comments: number | null;
  follows: number | null;
  leads: number | null;
  clickThrough: number | null;
  reach: number | null;
}

export interface ScoredPerformance {
  id: string;
  postId: string;
  performanceLabel: PerformanceLabel;
  conversionRate: number;
  engagementRate: number;
  ctaClickRate: number;
  followRate: number | null;
}

const TIME_SLOTS = ['morning', 'afternoon', 'evening', 'night'] as const;

function toPlatform(value: string): Platform {
  return value === 'facebook' || value === 'tiktok' ? value : 'website';
}

/** Derive a coarse time-of-day slot from a Date (used for post_time_slot). */
export function timeSlotFor(date: Date): (typeof TIME_SLOTS)[number] {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** Map a media asset kind onto the Performance_Record media_type vocabulary. */
function mediaTypeFor(kind: string | undefined): string {
  if (kind === 'video') return 'video';
  if (kind === 'photo_carousel') return 'photo_carousel';
  if (kind === 'image' || kind === 'photo') return 'image';
  return 'text';
}

export class ScoringService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: ScoringConfig = DEFAULT_SCORING_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Score an Analytics_Record against extracted Content_Features and persist a
   * Performance_Record. Returns the persisted summary.
   */
  async scoreRecord(record: AnalyticsRecordInput, features: ContentFeatures): Promise<ScoredPerformance> {
    const platform = toPlatform(record.platform);
    const metrics: RawMetrics = {
      views: record.views,
      likes: record.likes,
      shares: record.shares,
      comments: record.comments,
      follows: record.follows,
      leads: record.leads,
      clickThrough: record.clickThrough,
      reach: record.reach,
    };

    const { rates, insufficient } = computeRates(platform, metrics);
    const label = labelFor(rates.conversionRate, insufficient, this.config);

    const persisted = await this.prisma.performanceRecord.create({
      data: {
        postId: record.publishedPostId,
        domainCategory: features.domainCategory,
        contentTopic: features.contentTopic,
        personaId: features.personaId,
        toneOfVoice: features.toneOfVoice,
        objective: features.objective,
        platform: features.platform,
        postTimeSlot: features.postTimeSlot,
        contentLength: features.contentLength,
        hasCta: features.hasCta,
        ctaType: features.ctaType,
        mediaType: features.mediaType,
        conversionRate: rates.conversionRate,
        engagementRate: rates.engagementRate,
        ctaClickRate: rates.ctaClickRate,
        followRate: rates.followRate,
        performanceLabel: label,
        scoredAt: this.clock.now(),
      },
    });

    return {
      id: persisted.id,
      postId: persisted.postId,
      performanceLabel: label,
      conversionRate: rates.conversionRate,
      engagementRate: rates.engagementRate,
      ctaClickRate: rates.ctaClickRate,
      followRate: rates.followRate,
    };
  }

  /**
   * Recompute on recovery (Req 7.4): score the latest Analytics_Record for a
   * published post, extracting features from its draft. Returns null when there
   * is no analytics data yet for the post.
   */
  async scoreByPost(publishedPostId: string): Promise<ScoredPerformance | null> {
    const record = await this.prisma.analyticsRecord.findFirst({
      where: { publishedPostId },
      orderBy: { collectedAt: 'desc' },
    });
    if (!record) return null;
    const features = await this.extractFeatures(publishedPostId);
    return this.scoreRecord(record, features);
  }

  /**
   * Best-effort Content_Features extraction (Req 9.1) from the Scheduled_Post +
   * its Content_Draft, Domain, Persona, CTAs and media. Sensible defaults fill
   * any gap so scoring never fails on missing relations.
   */
  async extractFeatures(publishedPostId: string): Promise<ContentFeatures> {
    const post = await this.prisma.scheduledPost.findUnique({
      where: { id: publishedPostId },
      include: {
        draft: {
          include: {
            domain: true,
            persona: true,
            ctas: true,
            media: true,
          },
        },
      },
    });

    const platform = toPlatform(post?.platform ?? 'website');
    const slot = timeSlotFor(post?.scheduledAt ?? this.clock.now());
    const draft = post?.draft ?? null;

    if (!draft) {
      return {
        domainCategory: 'unknown',
        contentTopic: 'unknown',
        personaId: 'unknown',
        toneOfVoice: 'friendly',
        objective: 'View',
        platform,
        postTimeSlot: slot,
        contentLength: 0,
        hasCta: false,
        ctaType: 'none',
        mediaType: 'text',
      };
    }

    const ctas = draft.ctas ?? [];
    const hasCta = ctas.length > 0;
    const firstMedia = (draft.media ?? [])[0];

    return {
      domainCategory: draft.domain?.domainName ?? 'unknown',
      contentTopic: draft.title && draft.title.length > 0 ? draft.title : 'unknown',
      personaId: draft.personaId,
      toneOfVoice:
        draft.persona?.recommendedTone ?? draft.persona?.toneOfVoice ?? 'friendly',
      objective: draft.objective && draft.objective.length > 0 ? draft.objective : 'View',
      platform,
      postTimeSlot: slot,
      contentLength: typeof draft.body === 'string' ? draft.body.length : 0,
      hasCta,
      ctaType: hasCta ? 'link' : 'none',
      mediaType: mediaTypeFor(firstMedia?.kind),
    };
  }
}
