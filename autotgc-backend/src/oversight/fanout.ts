/**
 * Notification fan-out — PURE, framework-free (no Prisma / no EventBus).
 *
 * Given an arbitrary set of user accounts plus a description of a supervised
 * Important_Action, produce exactly one NotificationDraft per DISTINCT ADMIN
 * (de-duplicated by id), skipping SALES. The result length equals the number of
 * distinct ADMIN ids. Used as the target of a property test (Req 1.6, 8.1, 8.3,
 * 8.4). No I/O, no side effects — deterministic.
 */
import type { ActivityAction, NotificationKind } from './types';

/** Minimal account shape needed to decide notification recipients. */
export interface UserLike {
  id: string;
  role: 'ADMIN' | 'SALES';
}

/** A pure, persistence-agnostic notification description (one per ADMIN recipient). */
export interface NotificationDraft {
  recipientUserId: string;
  kind: NotificationKind; // 'ACTIVITY'
  message: string;
  refType: string | null; // = action.targetType
  refId: string | null; // = action.targetId
}

/** Describes a supervised Important_Action used to compose notifications (Req 8.3). */
export interface ActionDescriptor {
  actorUserId: string;
  action: ActivityAction;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown>;
}

/** Human-readable Vietnamese label for each supervised action kind. */
const ACTION_LABELS: Record<ActivityAction, string> = {
  DOCUMENT_VERIFIED: 'đã xác minh giấy tờ',
  CANDIDATE_STAGE_CHANGED: 'đã đổi giai đoạn ứng viên',
  LEAD_STATUS_CHANGED: 'đã đổi trạng thái lead',
};

/**
 * Compose a deterministic, human-readable Vietnamese message from an action.
 *
 * The message includes the actorUserId and the action label plus the target so
 * an admin can trace progress. PURE — no DB access, no event emission.
 */
export function describeActivity(action: ActionDescriptor): string {
  const label = ACTION_LABELS[action.action];
  return `Người dùng ${action.actorUserId} ${label} (${action.targetType}#${action.targetId}).`;
}

/**
 * PURE: return exactly one NotificationDraft for each DISTINCT ADMIN id in
 * `users` (de-duplicated by id), and zero for SALES. The result length equals
 * the number of distinct ADMIN ids. Each draft carries kind 'ACTIVITY',
 * message = describeActivity(action), refType = action.targetType, and
 * refId = action.targetId (Req 1.6, 8.1, 8.4). No DB access, no event emission.
 */
export function fanOutNotifications(
  users: readonly UserLike[],
  action: ActionDescriptor,
): NotificationDraft[] {
  const message = describeActivity(action);
  const seen = new Set<string>();
  const drafts: NotificationDraft[] = [];

  for (const user of users) {
    if (user.role !== 'ADMIN') continue;
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    drafts.push({
      recipientUserId: user.id,
      kind: 'ACTIVITY',
      message,
      refType: action.targetType,
      refId: action.targetId,
    });
  }

  return drafts;
}
