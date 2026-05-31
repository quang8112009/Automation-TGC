import { api } from '../lib/apiClient';
import type { DashboardNotification, DashboardOverview } from '../lib/types';

export function getOverview(): Promise<DashboardOverview> {
  return api.get<DashboardOverview>('/api/dashboard/overview');
}

export function getNotifications(): Promise<{ notifications: DashboardNotification[] }> {
  return api.get<{ notifications: DashboardNotification[] }>('/api/dashboard/notifications');
}
