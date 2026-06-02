/**
 * Dashboard_Service pure assembler (Lead/Dashboard Req 14-19).
 *
 * Additive, pure composition helpers for the Overview_Assembler and
 * Notifications_Assembler. They take already-read cross-module data (Content
 * Pipeline drafts/scheduled posts, Analytics insights, Token_Manager warnings)
 * and compose the derived read models. All I/O (the cross-module reads, the
 * clock) is injected by the caller so the composition is deterministic and
 * property-testable.
 */
import { isUpcoming, isDataStale } from './helpers';

export type DashboardPlatform = 'facebook' | 'tiktok' | 'website';
export type ContentStatusLike =
  | 'DRAFT' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'REJECTED' | 'FAILED';
export type InsightStatusLike = 'NEW' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

export interface DraftLike {
  id: string;
  status: ContentStatusLike;
  title: string;
  createdAt: string;       // ISO 8601
  deadlineAt?: string | null;
  /** Manual Approval_Queue priority (lower = more urgent); defaults to 0. (Req 10.3) */
  priorityIndex?: number;
}

export interface InsightLike {
  id: string;
  insightStatus: InsightStatusLike;
  title: string;
  createdAt: string;       // ISO 8601
  deadlineAt?: string | null;
  /** Manual Approval_Queue priority (lower = more urgent); defaults to 0. (Req 10.3) */
  priorityIndex?: number;
}

export interface ScheduledPostLike {
  id: string;
  platform: DashboardPlatform;
  status: ContentStatusLike;
  scheduledPublishTime: string; // ISO 8601
  title: string;
  failureReason?: string | null;
}

export interface ApprovalQueueItem {
  kind: 'DRAFT' | 'INSIGHT';
  id: string;
  createdAt: string;
  deadlineAt: string | null;
  title: string;
  /** Persisted manual priority (lower = more urgent); the primary sort key. (Req 10.3) */
  priorityIndex: number;
}

export interface UpcomingPost {
  scheduledPostId: string;
  platform: DashboardPlatform;
  scheduledPublishTime: string;
  title: string;
}

export interface AlertItem {
  kind: 'FAILED_POST' | 'TOKEN_EXPIRY';
  ref: string;
  reason: string;
}

export interface DataSyncStatus {
  lastSyncTime: string | null;
  current: boolean;
  warning: string | null;
}

export interface DashboardOverview {
  kpiOverview: unknown;
  approvalQueue: ApprovalQueueItem[];
  upcomingPosts: UpcomingPost[];
  alertSection: AlertItem[];
  dataSyncStatus: DataSyncStatus;
}

export type NotificationKind = 'TOKEN_EXPIRY' | 'PUBLISH_FAILURE' | 'INSIGHTS_PENDING';

export interface Notification {
  kind: NotificationKind;
  ref: string;
  message: string;
  raisedAt: string;
}

export interface TokenExpiryWarning {
  platform: string;
  reason: string;
  raisedAt?: string;
}

/**
 * Approval_Queue composition (Req 15.1): exactly the DRAFT drafts ∪
 * PENDING_REVIEW insights, ordered by the priority predicate (Req 15.2, 10.3).
 *
 * Ordering: persisted manual `priorityIndex` ascending FIRST (drag-and-drop
 * priority — Req 10.3), then the existing deadline-based criteria as the
 * tie-breaker (Req 15.2). Items without a `priorityIndex` default to 0, so the
 * pre-existing deadline ordering is preserved when nothing has been reordered.
 */
export function buildApprovalQueue(drafts: DraftLike[], insights: InsightLike[]): ApprovalQueueItem[] {
  const items: ApprovalQueueItem[] = [];
  for (const d of drafts) {
    if (d.status === 'DRAFT') {
      items.push({
        kind: 'DRAFT',
        id: d.id,
        createdAt: d.createdAt,
        deadlineAt: d.deadlineAt ?? null,
        title: d.title,
        priorityIndex: d.priorityIndex ?? 0,
      });
    }
  }
  for (const ins of insights) {
    if (ins.insightStatus === 'PENDING_REVIEW') {
      items.push({
        kind: 'INSIGHT',
        id: ins.id,
        createdAt: ins.createdAt,
        deadlineAt: ins.deadlineAt ?? null,
        title: ins.title,
        priorityIndex: ins.priorityIndex ?? 0,
      });
    }
  }
  return [...items].sort(compareApprovalItems);
}

/**
 * Priority predicate (Req 10.3, 15.2): the persisted manual `priorityIndex`
 * (ascending — lower is more urgent) is the primary key. Within an equal
 * `priorityIndex`, fall back to the existing deadline criteria: items with a
 * deadline sort before deadline-less items, nearest deadline first; deadline-less
 * items sort most-recently-created first. Total + deterministic so the order is
 * verifiable.
 */
export function compareApprovalItems(a: ApprovalQueueItem, b: ApprovalQueueItem): number {
  // Manual drag-and-drop priority wins first (Req 10.3).
  if (a.priorityIndex !== b.priorityIndex) return a.priorityIndex - b.priorityIndex;

  const ad = a.deadlineAt;
  const bd = b.deadlineAt;
  if (ad !== null && bd !== null) {
    const diff = Date.parse(ad) - Date.parse(bd); // nearest deadline first
    if (diff !== 0) return diff;
  } else if (ad !== null && bd === null) {
    return -1; // deadline items first
  } else if (ad === null && bd !== null) {
    return 1;
  }
  // both deadline-less (or equal deadlines): most-recently-created first
  const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (created !== 0) return created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Upcoming_Posts (Req 16): exactly SCHEDULED posts whose publish time is within
 * [now, now + windowDays] (inclusive boundaries via isUpcoming).
 */
export function buildUpcomingPosts(posts: ScheduledPostLike[], now: Date, windowDays = 7): UpcomingPost[] {
  return posts
    .filter((p) => p.status === 'SCHEDULED' && isUpcoming(new Date(p.scheduledPublishTime), now, windowDays))
    .map((p) => ({
      scheduledPostId: p.id,
      platform: p.platform,
      scheduledPublishTime: p.scheduledPublishTime,
      title: p.title,
    }));
}

/**
 * Alert_Section (Req 17): exactly the FAILED scheduled posts with their failure
 * reason (incl. TOKEN_EXPIRED), plus the Token_Manager token-expiry warnings.
 */
export function buildAlertSection(posts: ScheduledPostLike[], tokenWarnings: TokenExpiryWarning[] = []): AlertItem[] {
  const alerts: AlertItem[] = [];
  for (const p of posts) {
    if (p.status === 'FAILED') {
      alerts.push({ kind: 'FAILED_POST', ref: p.id, reason: p.failureReason ?? 'UNKNOWN' });
    }
  }
  for (const w of tokenWarnings) {
    alerts.push({ kind: 'TOKEN_EXPIRY', ref: w.platform, reason: w.reason });
  }
  return alerts;
}

/** Data_Sync_Status (Req 18): warning iff age > threshold; current at/within threshold. */
export function buildDataSyncStatus(lastSync: Date | null, now: Date, thresholdHours = 6): DataSyncStatus {
  const stale = isDataStale(lastSync, now, thresholdHours);
  return {
    lastSyncTime: lastSync ? lastSync.toISOString() : null,
    current: !stale,
    warning: stale ? 'data not updated; a manual sync is suggested' : null,
  };
}

/**
 * Notifications_Channel (Req 19.1): exactly the union of token-expiry warnings,
 * publish-failure alerts (a Scheduled_Post entering FAILED), and insights-pending
 * notifications (a Learning_Insight entering PENDING_REVIEW).
 */
export function buildNotifications(
  tokenWarnings: TokenExpiryWarning[],
  failedPosts: ScheduledPostLike[],
  pendingInsights: InsightLike[],
): Notification[] {
  const out: Notification[] = [];
  for (const w of tokenWarnings) {
    out.push({ kind: 'TOKEN_EXPIRY', ref: w.platform, message: w.reason, raisedAt: w.raisedAt ?? '' });
  }
  for (const p of failedPosts) {
    if (p.status === 'FAILED') {
      out.push({ kind: 'PUBLISH_FAILURE', ref: p.id, message: p.failureReason ?? 'publish failed', raisedAt: p.scheduledPublishTime });
    }
  }
  for (const ins of pendingInsights) {
    if (ins.insightStatus === 'PENDING_REVIEW') {
      out.push({ kind: 'INSIGHTS_PENDING', ref: ins.id, message: ins.title, raisedAt: ins.createdAt });
    }
  }
  return out;
}

/**
 * Overview assembly (Req 14.2): compose all five sections. The KPI overview is
 * passed through from the caller's cross-module read; the other four sections
 * are composed here. Always returns all five keys.
 */
export function assembleOverview(input: {
  kpiOverview: unknown;
  drafts: DraftLike[];
  insights: InsightLike[];
  scheduledPosts: ScheduledPostLike[];
  tokenWarnings?: TokenExpiryWarning[];
  lastSync: Date | null;
  now: Date;
  windowDays?: number;
  thresholdHours?: number;
}): DashboardOverview {
  return {
    kpiOverview: input.kpiOverview,
    approvalQueue: buildApprovalQueue(input.drafts, input.insights),
    upcomingPosts: buildUpcomingPosts(input.scheduledPosts, input.now, input.windowDays ?? 7),
    alertSection: buildAlertSection(input.scheduledPosts, input.tokenWarnings ?? []),
    dataSyncStatus: buildDataSyncStatus(input.lastSync, input.now, input.thresholdHours ?? 6),
  };
}
