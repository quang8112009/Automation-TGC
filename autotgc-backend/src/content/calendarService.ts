/**
 * Calendar_Manager — content calendar rendering + drag-and-drop reschedule
 * (Content Pipeline Req 4, 5).
 *
 * Rendering returns drafts and scheduled posts (with status + platform label)
 * for a month / week / day view, returning the available subset when one source
 * fails to load. Reschedule updates the publish time only when the post is
 * SCHEDULED and the new time is strictly later than the injected `now`.
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import { ConflictError, ValidationError } from '../infra/errors';
import type { ContentStatus } from './stateMachine';

export type CalendarView = 'month' | 'week' | 'day';

/** Distinct colors for the four statuses surfaced on the calendar (Req 4.2). */
const STATUS_COLORS: Readonly<Record<'SCHEDULED' | 'PUBLISHED' | 'DRAFT' | 'FAILED', string>> = {
  SCHEDULED: '#2563eb', // blue
  PUBLISHED: '#16a34a', // green
  DRAFT: '#9ca3af', // gray
  FAILED: '#dc2626', // red
};

/**
 * Injective status -> color mapping over {SCHEDULED, PUBLISHED, DRAFT, FAILED}
 * (Req 4.2). Any other status falls back to a neutral color.
 */
export function colorFor(status: ContentStatus): string {
  if (status === 'SCHEDULED' || status === 'PUBLISHED' || status === 'DRAFT' || status === 'FAILED') {
    return STATUS_COLORS[status];
  }
  return '#000000';
}

/** Human-friendly platform label for calendar items. */
export function platformLabel(platform: string): string {
  switch (platform) {
    case 'facebook':
      return 'Facebook';
    case 'tiktok':
      return 'TikTok';
    case 'website':
    case 'custom_cms':
      return 'Website';
    default:
      return platform;
  }
}

export interface CalendarDraftItem {
  id: string;
  title: string;
  status: string;
  color: string;
}

export interface CalendarScheduledItem {
  id: string;
  draftId: string;
  platform: string;
  platformLabel: string;
  scheduledAt: Date;
  status: string;
  color: string;
}

export interface CalendarResult {
  view: CalendarView;
  from: Date;
  to: Date;
  drafts: CalendarDraftItem[];
  scheduledPosts: CalendarScheduledItem[];
  /** Names of sources that failed to load; the available subset is still returned. */
  unavailable: string[];
}

/** Compute the [from, to) window for a view anchored at a reference date. */
export function viewWindow(view: CalendarView, reference: Date): { from: Date; to: Date } {
  const ref = new Date(reference.getTime());
  if (view === 'day') {
    const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
    const to = new Date(from.getTime() + 86_400_000);
    return { from, to };
  }
  if (view === 'week') {
    const day = ref.getUTCDay();
    const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - day);
    const to = new Date(start.getTime() + 7 * 86_400_000);
    return { from: start, to };
  }
  const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const to = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
  return { from, to };
}

export class CalendarService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Render the calendar for a view. If a source throws while loading, that
   * source is reported in `unavailable` and the remaining data is still returned
   * (Req 4.3 graceful degradation).
   */
  async getCalendar(view: CalendarView, reference?: Date): Promise<CalendarResult> {
    const anchor = reference ?? this.clock.now();
    const { from, to } = viewWindow(view, anchor);
    const unavailable: string[] = [];

    let drafts: CalendarDraftItem[] = [];
    try {
      const rows = await this.prisma.contentDraft.findMany({
        where: { createdAt: { gte: from, lt: to } },
        orderBy: { createdAt: 'asc' },
      });
      drafts = rows.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        color: colorFor(d.status as ContentStatus),
      }));
    } catch {
      unavailable.push('drafts');
    }

    let scheduledPosts: CalendarScheduledItem[] = [];
    try {
      const rows = await this.prisma.scheduledPost.findMany({
        where: { scheduledAt: { gte: from, lt: to } },
        orderBy: { scheduledAt: 'asc' },
      });
      scheduledPosts = rows.map((p) => ({
        id: p.id,
        draftId: p.draftId,
        platform: p.platform,
        platformLabel: platformLabel(p.platform),
        scheduledAt: p.scheduledAt,
        status: p.status,
        color: colorFor(p.status as ContentStatus),
      }));
    } catch {
      unavailable.push('scheduledPosts');
    }

    return { view, from, to, drafts, scheduledPosts, unavailable };
  }

  /**
   * Reschedule a SCHEDULED post to a strictly-future time (Req 5.1–5.3).
   * - Not found -> 404 is left to callers; here a missing row -> ValidationError.
   * - Non-SCHEDULED status -> 409 (ConflictError), time unchanged.
   * - Non-future time -> 400 (ValidationError), time unchanged.
   */
  async reschedule(scheduledPostId: string, newTime: Date): Promise<{ id: string; scheduledAt: Date }> {
    const post = await this.prisma.scheduledPost.findUnique({ where: { id: scheduledPostId } });
    if (!post) {
      throw new ValidationError('Scheduled post not found', 'SCHEDULED_POST_NOT_FOUND');
    }
    if (post.status !== 'SCHEDULED') {
      throw new ConflictError(
        `Cannot reschedule a post in status ${post.status}`,
        'RESCHEDULE_NOT_SCHEDULED',
      );
    }
    if (!isFuture(newTime, this.clock.now())) {
      throw new ValidationError('New publish time must be in the future', 'RESCHEDULE_NOT_FUTURE');
    }
    const updated = await this.prisma.scheduledPost.update({
      where: { id: scheduledPostId },
      data: { scheduledAt: newTime },
    });
    return { id: updated.id, scheduledAt: updated.scheduledAt };
  }
}

/** Pure shared future-time rule: strictly later than `now`. */
export function isFuture(when: Date, now: Date): boolean {
  return when.getTime() > now.getTime();
}
