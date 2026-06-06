/**
 * FollowUpService — behavior-based 1-1 nurture (Feature 3). I/O shell over the
 * pure `followUpEngine`: finds drop-off conversations, queues a personalized
 * FollowUpTask, and a worker sends due tasks via the channel sender. All
 * decisions/wording come from the pure engine; this class only does Prisma I/O
 * and channel sending.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { NotFoundError } from '../infra/errors';
import { isDropOff, buildFollowUpMessage } from './followUpEngine';
import type { ChannelSender, IntakeChannelValue } from './intakeService';
import { NOOP_SENDER } from './intakeService';

const SCAN_CAP = 200;
const DEFAULT_SEND_LIMIT = 50;

export class FollowUpService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sender: ChannelSender = NOOP_SENDER,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Scan ACTIVE conversations and queue a FollowUpTask for each drop-off (silent
   * >= threshold, no open follow-up). Returns counts. Idempotent: a conversation
   * with a PENDING/SENT follow-up is skipped (no double-queue).
   */
  async scanDropOffs(now: Date = this.clock()): Promise<{ scanned: number; queued: number }> {
    const convos = await this.prisma.intakeConversation.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { lastInboundAt: 'asc' },
      take: SCAN_CAP,
    });

    let queued = 0;
    for (const c of convos) {
      const openCount = await this.prisma.followUpTask.count({
        where: { conversationId: c.id, status: { in: ['PENDING', 'SENT'] } },
      });
      const drop = isDropOff(
        { status: c.status, lastInboundAt: c.lastInboundAt, hasOpenFollowUp: openCount > 0 },
        now,
      );
      if (!drop) continue;

      const collected = (c.collected ?? {}) as Record<string, unknown>;
      const topic = this.str(collected.desiredMarket) ?? this.str(collected.desiredIndustry) ?? '';
      const message = buildFollowUpMessage({ name: c.displayName, topic });

      await this.prisma.followUpTask.create({
        data: {
          conversationId: c.id,
          candidateId: c.candidateId ?? null,
          leadId: c.leadId ?? null,
          channel: c.channel,
          externalUserId: c.externalUserId,
          reason: 'drop_off_after_inquiry',
          topic,
          message,
          status: 'PENDING',
          dueAt: now,
        },
      });
      queued += 1;
    }
    return { scanned: convos.length, queued };
  }

  /**
   * Send PENDING follow-ups whose dueAt has passed. Best-effort: a send failure
   * leaves the task PENDING for a later retry. Returns counts.
   */
  async sendDue(now: Date = this.clock(), limit = DEFAULT_SEND_LIMIT): Promise<{ sent: number; failed: number }> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SEND_LIMIT;
    const due = await this.prisma.followUpTask.findMany({
      where: { status: 'PENDING', dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: safeLimit,
    });

    let sent = 0;
    let failed = 0;
    for (const t of due) {
      try {
        await this.sender.send(t.channel as IntakeChannelValue, t.externalUserId, t.message);
        await this.prisma.followUpTask.update({
          where: { id: t.id },
          data: { status: 'SENT', sentAt: now },
        });
        sent += 1;
      } catch {
        failed += 1; // leave PENDING for retry
      }
    }
    return { sent, failed };
  }

  /**
   * Paginated list of follow-up tasks (optional status filter). SALES is scoped
   * to follow-ups attached to candidates they own (`candidateProfile.assignedTo
   * === actor.userId`); tasks with no candidate (candidateId null) are excluded
   * for SALES (fail-closed, Req 3.6/4.4). ADMIN is unconstrained.
   */
  async list(status: string | undefined, page = 1, limit = 20, actor: AuthInfo): Promise<unknown> {
    const where: Prisma.FollowUpTaskWhereInput = status ? { status: status as never } : {};

    if (actor.role === 'SALES') {
      // Resolve the candidate ids this SALES user owns, then constrain to them.
      // `candidateId in {ownedIds}` excludes null-candidate tasks automatically
      // (null is never a member of the list) → fail-closed for unowned/global.
      const owned = await this.prisma.candidateProfile.findMany({
        where: { assignedTo: actor.userId },
        select: { id: true },
      });
      where.candidateId = { in: owned.map((c) => c.id) };
    }

    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;
    const [items, total] = await Promise.all([
      this.prisma.followUpTask.findMany({
        where,
        orderBy: { dueAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.followUpTask.count({ where }),
    ]);
    return { items, total, page: safePage, limit: safeLimit };
  }

  /** Cancel a follow-up task (404 if missing). */
  async cancel(id: string): Promise<unknown> {
    const existing = await this.prisma.followUpTask.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('Follow-up task not found', 'FOLLOW_UP_NOT_FOUND');
    }
    return this.prisma.followUpTask.update({ where: { id }, data: { status: 'CANCELLED' } });
  }

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  }
}
