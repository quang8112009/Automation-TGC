import { api } from '../lib/apiClient';
import type {
  ApprovalQueueItem,
  DashboardNotification,
  DashboardOverview,
} from '../lib/types';

export function getOverview(): Promise<DashboardOverview> {
  return api.get<DashboardOverview>('/api/dashboard/overview');
}

export function getNotifications(): Promise<{ notifications: DashboardNotification[] }> {
  return api.get<{ notifications: DashboardNotification[] }>('/api/dashboard/notifications');
}

/** One row returned by the reorder endpoint (id + kind + persisted priority). */
export interface ApprovalQueueReorderRow {
  id: string;
  kind: ApprovalQueueItem['kind'];
  priorityIndex: number;
}

/**
 * Persist a manual drag-and-drop priority for the Approval_Queue (ADMIN only;
 * SALES is rejected with 403 by the backend). `orderedIds` is the full set of
 * queue item ids in their new order; the backend writes the matching
 * priorityIndex on each ContentDraft / LearningInsight row (Req 10.1, 10.3).
 */
export function reorderApprovalQueue(
  orderedIds: string[],
): Promise<{ items: ApprovalQueueReorderRow[] }> {
  return api.post<{ items: ApprovalQueueReorderRow[] }>('/api/v1/approval-queue/reorder', {
    orderedIds,
  });
}
