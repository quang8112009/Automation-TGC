/**
 * Notifications API — persisted notification reads/writes (Req 8.6, 9.1, 9.2, 9.4).
 *
 * Mirrors `api/dashboard.ts` conventions: thin typed wrappers over the shared
 * `api` helper. These back the persistent NotificationsBell (server is the
 * authoritative source of read-state); the realtime stream remains the live
 * signal that nudges these queries to refetch.
 *
 * Backend contract (autotgc-backend/src/oversight/routes.ts):
 *   - GET  /api/v1/notifications              -> { items, total }   (self, newest first)
 *   - GET  /api/v1/notifications/unread-count -> { count }          (self)
 *   - POST /api/v1/notifications/:id/read     -> PersistedNotification (idempotent)
 */
import { api } from '../lib/apiClient';

/** A persisted notification row (mirrors backend NotificationView; dates as ISO strings). */
export interface PersistedNotification {
  id: string;
  recipientUserId: string;
  kind: string;
  message: string;
  refType: string | null;
  refId: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationListResult {
  items: PersistedNotification[];
  total: number;
}

/** Caller's notifications, newest first (Req 9.1). */
export function listNotifications(page = 1, limit = 50): Promise<NotificationListResult> {
  return api.get<NotificationListResult>('/api/v1/notifications', { page, limit });
}

/** Caller's unread notification count (Req 9.4) — the authoritative badge source. */
export function getUnreadCount(): Promise<{ count: number }> {
  return api.get<{ count: number }>('/api/v1/notifications/unread-count');
}

/** Idempotent mark-as-read for one of the caller's notifications (Req 9.2). */
export function markNotificationRead(id: string): Promise<PersistedNotification> {
  return api.post<PersistedNotification>(
    `/api/v1/notifications/${encodeURIComponent(id)}/read`,
  );
}
