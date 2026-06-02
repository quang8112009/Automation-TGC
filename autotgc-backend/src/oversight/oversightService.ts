/**
 * Oversight_Service — the SINGLE central emit point for supervised
 * Important_Action events (design §5, Req 7, 8, 10.4, 10.5).
 *
 * Every supervised business action (document verified, candidate stage changed,
 * lead status changed) funnels through `record`, which — in order — appends
 * exactly one ActivityLog, reads all ADMIN accounts, fans out exactly one
 * Notification per distinct ADMIN, and publishes exactly one realtime event.
 *
 * The ENTIRE body is wrapped in try/catch: any failure in logging, notification
 * persistence, or event publishing is swallowed (best-effort) and NEVER
 * rethrown, so a failure here can never roll back or break the already-committed
 * business action (Req 7.5, 8.5). It MUST be called AFTER the business action
 * commits.
 */
import type { PrismaClient } from '@prisma/client';
import type { ActivityLogger } from './activityLogger';
import type { NotificationService } from './notificationService';
import { fanOutNotifications, type UserLike } from './fanout';
import type { ActivityAction } from './types';

/** A supervised business action to be recorded + fanned out to ADMINs. */
export interface ImportantAction {
  actorUserId: string;
  action: ActivityAction;
  targetType: string; // 'document' | 'candidate' | 'lead'
  targetId: string;
  detail: Record<string, unknown>;
}

export class OversightService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly activityLogger: ActivityLogger,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * The SINGLE central emit point for each Important_Action (Req 10.4, 10.5):
   *   1) append exactly one ActivityLog;
   *   2) read every UserAccount with role=ADMIN (id + role only);
   *   3) fanOutNotifications(admins, action) -> exactly one draft per ADMIN;
   *   4) notifications.createForAdmins(drafts, eventPayload) — persist N rows +
   *      publish exactly one `notification` DomainEvent.
   *
   * The whole body is wrapped in try/catch: every auxiliary error is swallowed
   * (best-effort) and NEVER rethrown, so a failure in logging/notification/
   * realtime never rolls back or breaks the already-committed business action
   * (Req 7.5, 8.5). Call AFTER the business action commits.
   */
  async record(action: ImportantAction): Promise<void> {
    try {
      // (1) Exactly one ActivityLog, detail stored verbatim.
      await this.activityLogger.append({
        actorUserId: action.actorUserId,
        action: action.action,
        targetType: action.targetType,
        targetId: action.targetId,
        detail: action.detail,
      });

      // (2) Read all ADMIN accounts (id + role only).
      const adminRows = await this.prisma.userAccount.findMany({
        where: { role: 'ADMIN' },
        select: { id: true, role: true },
      });
      const admins: UserLike[] = adminRows.map((row) => ({ id: row.id, role: row.role }));

      // (3) Pure fan-out: exactly one draft per distinct ADMIN.
      const drafts = fanOutNotifications(admins, {
        actorUserId: action.actorUserId,
        action: action.action,
        targetType: action.targetType,
        targetId: action.targetId,
        detail: action.detail,
      });

      // (4) Persist N notifications + publish exactly one realtime event. The
      // event payload carries enough context for the realtime frame.
      await this.notifications.createForAdmins(drafts, {
        actorUserId: action.actorUserId,
        action: action.action,
        targetType: action.targetType,
        targetId: action.targetId,
      });
    } catch {
      // Best-effort: swallow ANY auxiliary failure so a logging/notification/
      // realtime error never rolls back or breaks the committed business
      // action (Req 7.5, 8.5). Intentionally not rethrown.
    }
  }
}
