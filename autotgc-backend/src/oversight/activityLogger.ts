/**
 * Activity_Log — append-only multi-entity ledger (design §2, Req 2).
 *
 * Mirrors the `AuditLog` pattern: exposes ONLY `append` plus read helpers; there
 * is no update or delete path, enforcing the append-only contract at the API
 * layer (Req 2.2, 10.6). Every supervised Important_Action (document verified,
 * candidate stage changed, lead status changed) is recorded here so ADMIN can
 * reconstruct who did what, to which entity, and when.
 */
import type { PrismaClient } from '@prisma/client';
import type { ActivityAction } from './types';

export interface ActivityLogView {
  id: string;
  actorUserId: string;
  action: ActivityAction;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export class ActivityLogger {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The only writer. Records a new activity entry; the server stamps `createdAt`
   * (the caller must NOT pass it — Req 2.4). `detail` is stored verbatim as a
   * Prisma Json column (Req 2.6).
   */
  async append(input: {
    actorUserId: string;
    action: ActivityAction;
    targetType: string;
    targetId: string;
    detail: Record<string, unknown>;
  }): Promise<ActivityLogView> {
    const row = await this.prisma.activityLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        detail: input.detail as object,
      },
    });
    return this.toView(row);
  }

  /** Recent_Activity_Feed: most recent entries first (paginated) — Req 6.2, 6.5. */
  async listRecent(page = 1, limit = 50): Promise<{ items: ActivityLogView[]; total: number }> {
    const take = limit > 0 ? limit : 50;
    const skip = (page > 0 ? page - 1 : 0) * take;
    const [rows, total] = await Promise.all([
      this.prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.activityLog.count(),
    ]);
    return { items: rows.map((r) => this.toView(r)), total };
  }

  private toView(row: {
    id: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    detail: unknown;
    createdAt: Date;
  }): ActivityLogView {
    return {
      id: row.id,
      actorUserId: row.actorUserId,
      action: row.action as ActivityAction,
      targetType: row.targetType,
      targetId: row.targetId,
      detail: (row.detail ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
    };
  }
}
