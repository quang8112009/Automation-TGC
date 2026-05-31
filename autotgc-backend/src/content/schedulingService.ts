/**
 * Scheduling_Service — schedule an APPROVED draft across platforms with
 * per-platform gates and unique idempotency keys (Content Pipeline Req 12, 18).
 *
 * Each (draft, platform) pair is evaluated independently: the publish time must
 * be strictly future, and TikTok additionally requires an attached video or
 * photo_carousel asset AND a description strictly under 2200 characters
 * (including hashtags). Failing platforms are rejected individually while the
 * rest proceed; each created post receives a UUID idempotency key and SCHEDULED
 * status. `retryFailed` re-applies the same gates to recover a FAILED post.
 */
import { randomUUID } from 'crypto';
import type { ContentDraft, PrismaClient, ScheduledPost } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import { ConflictError, NotFoundError, ValidationError } from '../infra/errors';
import { MediaService, isTikTokEligible } from './mediaService';
import { isFuture } from './calendarService';
import type { EventBus } from '../infra/events';

/** Draft platform identifiers used by the content pipeline (Req 12.1). */
export type DraftPlatform = 'facebook' | 'tiktok' | 'website';
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<DraftPlatform>(['facebook', 'tiktok', 'website']);

/** TikTok description hard limit (Req 12.3): strictly under 2200 chars. */
export const TIKTOK_MAX_DESCRIPTION = 2200;

export interface ScheduleRequest {
  draftId: string;
  platforms: string[];
  /** Per-platform ISO-8601 publish times. */
  scheduledAt: Record<string, string>;
}

export interface ScheduleRejection {
  platform: string;
  code: string;
  reason: string;
}

export interface ScheduleResult {
  created: ScheduledPost[];
  rejected: ScheduleRejection[];
}

/** Inputs to the pure per-platform gate. */
export interface GateInputs {
  platform: string;
  scheduledAt: Date;
  now: Date;
  hasTikTokMedia: boolean;
  descriptionLength: number;
}

export type GateResult = { ok: true } | { ok: false; code: string; reason: string };

/**
 * Pure per-platform scheduling gate (Req 12.3–12.5). Independent of any single
 * platform's state so it can be property-tested deterministically.
 */
export function evaluatePlatformGate(input: GateInputs): GateResult {
  if (!KNOWN_PLATFORMS.has(input.platform)) {
    return { ok: false, code: 'UNKNOWN_PLATFORM', reason: `Unknown platform: ${input.platform}` };
  }
  if (!isFuture(input.scheduledAt, input.now)) {
    return { ok: false, code: 'NOT_FUTURE', reason: 'Publish time must be in the future' };
  }
  if (input.platform === 'tiktok') {
    if (!input.hasTikTokMedia) {
      return {
        ok: false,
        code: 'TIKTOK_MEDIA_REQUIRED',
        reason: 'TikTok requires an attached video or photo carousel',
      };
    }
    if (!(input.descriptionLength < TIKTOK_MAX_DESCRIPTION)) {
      return {
        ok: false,
        code: 'TIKTOK_DESCRIPTION_TOO_LONG',
        reason: `TikTok description must be under ${TIKTOK_MAX_DESCRIPTION} characters`,
      };
    }
  }
  return { ok: true };
}

/** The description used for the TikTok length gate: body + CTAs. */
export function draftDescriptionLength(body: string, ctas: ReadonlyArray<string>): number {
  return [body, ...ctas].filter((s) => s.length > 0).join('\n\n').length;
}

export class SchedulingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mediaService: MediaService,
    private readonly clock: Clock = systemClock,
    private readonly eventBus?: EventBus,
  ) {}

  /** Publish a scheduled-post lifecycle event (best-effort; never blocks). */
  private async emit(
    type: 'scheduled' | 'published' | 'failed',
    post: ScheduledPost,
  ): Promise<void> {
    if (!this.eventBus) return;
    try {
      await this.eventBus.publish({
        topic: 'scheduled_post',
        type,
        payload: { id: post.id, status: post.status, platform: post.platform },
      });
    } catch {
      // Non-critical; swallow.
    }
  }

  /**
   * Fan out an APPROVED draft to the requested platforms (Req 12.1–12.6).
   * Rejects the whole request with 409 when the draft is not APPROVED.
   */
  async schedule(req: ScheduleRequest): Promise<ScheduleResult> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: req.draftId },
      include: { ctas: true },
    });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }
    if (draft.status !== 'APPROVED') {
      throw new ConflictError('Draft must be APPROVED before scheduling', 'DRAFT_NOT_APPROVED');
    }
    const platforms = req.platforms ?? [];
    if (platforms.length === 0) {
      throw new ValidationError('At least one platform is required', 'SCHEDULE_PLATFORM_REQUIRED');
    }

    const assets = await this.mediaService.listForDraft(draft.id);
    const hasTikTokMedia = isTikTokEligible(assets);
    const descriptionLength = draftDescriptionLength(
      draft.body,
      draft.ctas.map((c) => c.ctaText),
    );
    const now = this.clock.now();

    const created: ScheduledPost[] = [];
    const rejected: ScheduleRejection[] = [];

    for (const platform of platforms) {
      const iso = req.scheduledAt?.[platform];
      const scheduledAt = parseIso(iso);
      if (scheduledAt === null) {
        rejected.push({ platform, code: 'INVALID_TIME', reason: 'Missing or invalid scheduled time' });
        continue;
      }

      const gate = evaluatePlatformGate({
        platform,
        scheduledAt,
        now,
        hasTikTokMedia,
        descriptionLength,
      });
      if (!gate.ok) {
        rejected.push({ platform, code: gate.code, reason: gate.reason });
        continue;
      }

      const post = await this.prisma.scheduledPost.create({
        data: {
          draftId: draft.id,
          platform,
          scheduledAt,
          status: 'SCHEDULED',
          idempotencyKey: randomUUID(),
        },
      });
      created.push(post);
      await this.emit('scheduled', post);
    }

    return { created, rejected };
  }

  /**
   * Recover a FAILED post (Req 18.1–18.3): transition FAILED->SCHEDULED with the
   * new time only when the new time is strictly future and the post passes the
   * per-platform gates; otherwise reject and leave the status unchanged.
   */
  async retryFailed(scheduledPostId: string, newTime: Date): Promise<ScheduledPost> {
    const post = await this.prisma.scheduledPost.findUnique({ where: { id: scheduledPostId } });
    if (!post) {
      throw new NotFoundError('Scheduled post not found', 'SCHEDULED_POST_NOT_FOUND');
    }
    if (post.status !== 'FAILED') {
      throw new ConflictError(
        `Only FAILED posts can be retried (status ${post.status})`,
        'RETRY_NOT_FAILED',
      );
    }

    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: post.draftId },
      include: { ctas: true },
    });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }

    const assets = await this.mediaService.listForDraft(draft.id);
    const gate = evaluatePlatformGate({
      platform: post.platform,
      scheduledAt: newTime,
      now: this.clock.now(),
      hasTikTokMedia: isTikTokEligible(assets),
      descriptionLength: draftDescriptionLength(
        draft.body,
        draft.ctas.map((c) => c.ctaText),
      ),
    });
    if (!gate.ok) {
      if (gate.code === 'NOT_FUTURE') {
        throw new ValidationError(gate.reason, gate.code);
      }
      throw new ConflictError(gate.reason, gate.code);
    }

    const updated = await this.prisma.scheduledPost.update({
      where: { id: scheduledPostId },
      data: {
        status: 'SCHEDULED',
        scheduledAt: newTime,
        errorCode: null,
        failureReason: null,
      },
    });
    await this.emit('scheduled', updated);
    return updated;
  }
}

/** Helper kept for callers needing a draft-aware description string. */
export function draftDescription(draft: Pick<ContentDraft, 'body'>, ctas: ReadonlyArray<string>): string {
  return [draft.body, ...ctas].filter((s) => s.length > 0).join('\n\n');
}

/** Parse an ISO time, returning null when missing/invalid. */
function parseIso(iso: string | undefined): Date | null {
  if (typeof iso !== 'string' || iso.trim().length === 0) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
