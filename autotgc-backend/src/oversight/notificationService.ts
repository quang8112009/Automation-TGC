/**
 * Notification_Service — persistence + realtime fan-out (design §4, Req 8, 9).
 *
 * Creates persistent Notification rows (one per ADMIN recipient) from pure
 * NotificationDraft values and publishes exactly one DomainEvent on the
 * `notification` topic so the realtime layer fans it out to connected ADMIN
 * sessions (Req 8.1, 8.2). Also exposes per-recipient query helpers: list
 * (newest first), unread count, and an idempotent, owner-checked mark-as-read
 * (Req 9.1–9.6). Errors are typed AppError subclasses from infra/errors.
 */
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '../infra/events';
import { ForbiddenError, NotFoundError } from '../infra/errors';
import type { NotificationDraft } from './fanout';

export interface NotificationView {
  id: string;
  recipientUserId: string;
  kind: string;
  message: string;
  refType: string | null;
  refId: string | null;
  read: boolean;
  createdAt: Date;
}

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Persist one Notification row per draft (createMany) then publish exactly one
   * `notification` event so the realtime layer fans it out to ADMIN sessions
   * (Req 8.1, 8.2). When there are no drafts, persist nothing and publish
   * nothing, returning 0. Returns the number of rows created.
   */
  async createForAdmins(
    drafts: NotificationDraft[],
    eventPayload: Record<string, unknown>,
  ): Promise<number> {
    if (drafts.length === 0) return 0;

    await this.prisma.notification.createMany({
      data: drafts.map((draft) => ({
        recipientUserId: draft.recipientUserId,
        kind: draft.kind,
        message: draft.message,
        refType: draft.refType,
        refId: draft.refId,
      })),
    });

    await this.eventBus?.publish({
      topic: 'notification',
      type: 'activity',
      payload: eventPayload,
    });

    return drafts.length;
  }

  /** Notifications for the caller, newest first, paginated (Req 9.1). */
  async list(
    recipientUserId: string,
    page = 1,
    limit = 50,
  ): Promise<{ items: NotificationView[]; total: number }> {
    const take = limit > 0 ? limit : 50;
    const skip = (page > 0 ? page - 1 : 0) * take;
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { recipientUserId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.notification.count({ where: { recipientUserId } }),
    ]);
    return { items: rows.map((r) => this.toView(r)), total };
  }

  /** Count of the caller's unread notifications (Req 9.4). */
  async unreadCount(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({ where: { recipientUserId, read: false } });
  }

  /**
   * Mark one of the caller's notifications as read. 404 when it does not exist
   * (Req 9.6); 403 when it belongs to someone else (Req 9.3). Idempotent: a
   * notification already read is returned unchanged (Req 9.5).
   */
  async markRead(notificationId: string, callerUserId: string): Promise<NotificationView> {
    const existing = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!existing) throw new NotFoundError('Notification not found', 'NOTIFICATION_NOT_FOUND');
    if (existing.recipientUserId !== callerUserId) {
      throw new ForbiddenError('Cannot mark another user\'s notification as read');
    }
    if (existing.read) return this.toView(existing);

    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { read: true },
    });
    return this.toView(updated);
  }

  private toView(row: {
    id: string;
    recipientUserId: string;
    kind: string;
    message: string;
    refType: string | null;
    refId: string | null;
    read: boolean;
    createdAt: Date;
  }): NotificationView {
    return {
      id: row.id,
      recipientUserId: row.recipientUserId,
      kind: row.kind,
      message: row.message,
      refType: row.refType,
      refId: row.refId,
      read: row.read,
      createdAt: row.createdAt,
    };
  }
}
