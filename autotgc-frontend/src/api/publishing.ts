import { api } from '../lib/apiClient';

export interface ScheduleInput {
  draftId: string;
  platforms: string[];
  /** Map of platform -> ISO datetime string. */
  scheduledAt: Record<string, string>;
}

export function schedulePost(input: ScheduleInput): Promise<unknown> {
  return api.post<unknown>('/api/publishing/schedule', input);
}

export function retryScheduledPost(id: string, scheduledAt: string): Promise<unknown> {
  return api.post<unknown>(
    `/api/publishing/scheduled/${encodeURIComponent(id)}/retry`,
    { scheduledAt },
  );
}

export function triggerPublish(scheduledPostId: string): Promise<unknown> {
  return api.post<unknown>('/api/publishing/post', { scheduledPostId });
}
