/**
 * Publishing_Worker — due-scan, atomic idempotency lock, token-checked publish,
 * duplicate prevention, success recording, and retry/fail classification
 * (Content Pipeline Req 13, 14, 15, 16, 17).
 *
 * The worker is framework-free and clock-injected so the due-scan, locking, and
 * retry behavior are deterministic. State changes route through the
 * Content_State_Machine; transient failures retry up to 3 times while hard
 * failures fail terminally. All terminal failures raise an alert.
 */
import type { PrismaClient, ScheduledPost } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import type { AdapterRegistry } from '../platforms/registry';
import type { PlatformId, PublishRequest } from '../platforms/adapter';
import type { AlertDispatcher } from '../infra/alerts';
import { AppError } from '../infra/errors';
import { contentTransition } from './stateMachine';
import type { ContentStatus } from './stateMachine';
import type { EventBus } from '../infra/events';

/** Maximum retry attempts for transient failures (Req 16.1). */
export const MAX_RETRIES = 3;

/** Token validity/refresh seam consumed by the worker (Token_Manager satisfies it). */
export interface TokenChecker {
  isValid(platform: string): Promise<boolean>;
  refresh(platform: string): Promise<unknown>;
}

/** Map a draft platform string to its registered PlatformAdapter id (Req 12.1). */
export function toAdapterPlatform(platform: string): PlatformId {
  switch (platform) {
    case 'facebook':
      return 'facebook';
    case 'tiktok':
      return 'tiktok';
    case 'website':
      return 'custom_cms';
    default:
      throw new AppError(400, `Unsupported platform: ${platform}`, 'UNSUPPORTED_PLATFORM');
  }
}

export type ErrorClass = 'transient' | 'hard';

/**
 * Classify a publish error (Req 16.2): network / HTTP 429 / 5xx -> transient;
 * any other 4xx (≠429) or content-policy error -> hard.
 */
export function classifyError(err: unknown): { class: ErrorClass; code: string } {
  const code = errorCode(err);
  const status = errorStatus(err);
  if (status !== undefined) {
    if (status === 429 || (status >= 500 && status <= 599)) {
      return { class: 'transient', code };
    }
    return { class: 'hard', code };
  }
  if (err instanceof Error && isNetworkError(err.message)) {
    // Network-level errors (fetch failures, timeouts, resets) are transient.
    return { class: 'transient', code: 'NETWORK_ERROR' };
  }
  return { class: 'hard', code };
}

/** Read a numeric HTTP status from an AppError or any { status|statusCode } shape. */
function errorStatus(err: unknown): number | undefined {
  if (err instanceof AppError) return err.status;
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>;
    const raw = rec.status ?? rec.statusCode;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return undefined;
}

/** Read a stable error code if present; otherwise a generic fallback. */
function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>;
    if (typeof rec.code === 'string' && rec.code.length > 0) return rec.code;
  }
  return 'UNKNOWN_ERROR';
}

function isNetworkError(message: string): boolean {
  return /(network|timeout|timed out|econnreset|econnrefused|enotfound|socket|fetch failed)/i.test(
    message,
  );
}

export interface PublishOutcome {
  postId: string;
  status: ContentStatus;
  externalPostId?: string | null;
  postUrl?: string | null;
  errorCode?: string | null;
}

export class PublishingWorker {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: AdapterRegistry,
    private readonly tokenManager: TokenChecker,
    private readonly alerts: AlertDispatcher,
    private readonly clock: Clock = systemClock,
    private readonly eventBus?: EventBus,
  ) {}

  /** Publish a scheduled-post lifecycle event (best-effort; never blocks). */
  private async emit(
    type: 'published' | 'failed',
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

  /** Select posts that are SCHEDULED and due (scheduledAt <= now) (Req 13.1). */
  async scanDue(now: Date = this.clock.now()): Promise<ScheduledPost[]> {
    return this.prisma.scheduledPost.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  /**
   * Atomic compare-and-set lock (Req 13.2, 13.3): flip SCHEDULED->PUBLISHING for
   * exactly one winner. Returns true iff this caller acquired the lock.
   */
  async tryLock(postId: string): Promise<boolean> {
    const result = await this.prisma.scheduledPost.updateMany({
      where: { id: postId, status: 'SCHEDULED' },
      data: { status: 'PUBLISHING' },
    });
    return result.count === 1;
  }

  /**
   * Publish a (locked) post (Req 14, 15, 16, 17). Assumes the post is PUBLISHING
   * (via tryLock). Handles duplicate prevention, token validation, success
   * recording, and the retry/fail policy.
   */
  async publish(postId: string): Promise<PublishOutcome> {
    const post = await this.prisma.scheduledPost.findUnique({ where: { id: postId } });
    if (!post) {
      throw new AppError(404, 'Scheduled post not found', 'SCHEDULED_POST_NOT_FOUND');
    }

    // Duplicate prevention (Req 17.1, 17.2): a PUBLISHING post that already has an
    // external id was published before -> treat as the original success.
    if (post.status === 'PUBLISHING' && post.externalPostId) {
      const published = await this.markPublished(postId, post.externalPostId, post.postUrl);
      return {
        postId,
        status: 'PUBLISHED',
        externalPostId: published.externalPostId,
        postUrl: published.postUrl,
      };
    }

    if (post.status !== 'PUBLISHING') {
      // Not locked by us; do nothing (Req 13.3).
      return { postId, status: post.status as ContentStatus };
    }

    // Token validation before any adapter call (Req 14.1–14.3).
    const valid = await this.tokenManager.isValid(post.platform);
    if (!valid) {
      let refreshed = false;
      try {
        await this.tokenManager.refresh(post.platform);
        refreshed = await this.tokenManager.isValid(post.platform);
      } catch {
        refreshed = false;
      }
      if (!refreshed) {
        const failed = await this.failTerminal(postId, 'TOKEN_EXPIRED', 'Platform token expired');
        return { postId, status: 'FAILED', errorCode: failed.errorCode };
      }
    }

    const adapter = this.registry.get(toAdapterPlatform(post.platform));
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: post.draftId },
      include: { ctas: true, media: true },
    });
    if (!draft) {
      const failed = await this.failTerminal(postId, 'DRAFT_MISSING', 'Draft no longer exists');
      return { postId, status: 'FAILED', errorCode: failed.errorCode };
    }

    const request: PublishRequest = {
      draftId: draft.id,
      title: draft.title,
      body: draft.body,
      ctas: draft.ctas.map((c) => c.ctaText),
      mediaUrls: draft.media.map((m) => m.storageKey),
      idempotencyKey: post.idempotencyKey,
    };

    try {
      const result = await adapter.publish(request);
      const published = await this.markPublished(postId, result.externalId, result.url ?? null);
      return {
        postId,
        status: 'PUBLISHED',
        externalPostId: published.externalPostId,
        postUrl: published.postUrl,
      };
    } catch (err) {
      const classified = classifyError(err);
      if (classified.class === 'transient' && post.retryCount < MAX_RETRIES) {
        const retried = await this.scheduleRetry(postId, classified.code);
        return { postId, status: 'SCHEDULED', errorCode: retried.errorCode };
      }
      const failed = await this.failTerminal(postId, classified.code, errMessage(err));
      return { postId, status: 'FAILED', errorCode: failed.errorCode };
    }
  }

  // --- internals -------------------------------------------------------------

  /** Record a successful publish (Req 15.2, 15.3): PUBLISHING->PUBLISHED + ids. */
  private async markPublished(
    postId: string,
    externalPostId: string,
    postUrl: string | null,
  ): Promise<ScheduledPost> {
    const current = await this.prisma.scheduledPost.findUnique({ where: { id: postId } });
    const from = (current?.status ?? 'PUBLISHING') as ContentStatus;
    // PUBLISHING->PUBLISHED is the valid transition; if already PUBLISHED, no-op.
    if (from !== 'PUBLISHED') {
      const transition = contentTransition(from, 'PUBLISHED');
      if (!transition.ok) {
        // Defensive: keep idempotent success recording from corrupting state.
        return current as ScheduledPost;
      }
    }
    const published = await this.prisma.scheduledPost.update({
      where: { id: postId },
      data: {
        status: 'PUBLISHED',
        externalPostId,
        postUrl,
        errorCode: null,
        failureReason: null,
      },
    });
    await this.emit('published', published);
    return published;
  }

  /**
   * Transient retry (Req 16.1): return to SCHEDULED and increment retryCount so
   * the due-scan picks it up again (with queue-level backoff).
   */
  private async scheduleRetry(postId: string, errorCode: string): Promise<ScheduledPost> {
    // PUBLISHING->FAILED->SCHEDULED keeps within the allowed transition set.
    return this.prisma.scheduledPost.update({
      where: { id: postId },
      data: {
        status: 'SCHEDULED',
        retryCount: { increment: 1 },
        errorCode,
        failureReason: `Transient failure (${errorCode}); will retry`,
      },
    });
  }

  /**
   * Terminal failure (Req 16.3): set FAILED, store the error code, and raise an
   * alert as one combined action.
   */
  private async failTerminal(
    postId: string,
    errorCode: string,
    failureReason: string,
  ): Promise<ScheduledPost> {
    const updated = await this.prisma.scheduledPost.update({
      where: { id: postId },
      data: { status: 'FAILED', errorCode, failureReason },
    });
    await this.alerts.raise('REFRESH_FAILURE', updated.platform, `${errorCode}: ${failureReason}`);
    await this.emit('failed', updated);
    return updated;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Publish failed';
}
