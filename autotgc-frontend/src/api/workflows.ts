import { api } from '../lib/apiClient';
import type { WorkflowRun, WorkflowStartResult } from '../lib/types';

export interface StartWorkflowInput {
  domainName: string;
  personaIds: string[];
  objective?: string;
  platforms?: string[];
  /** Map of platform -> ISO datetime string. */
  scheduledAt?: Record<string, string>;
}

export function startWorkflow(input: StartWorkflowInput): Promise<WorkflowStartResult> {
  return api.post<WorkflowStartResult>('/api/v1/workflows', input);
}

export function getWorkflow(id: string): Promise<WorkflowRun> {
  return api.get<WorkflowRun>(`/api/v1/workflows/${encodeURIComponent(id)}`);
}

export function resumeWorkflow(id: string): Promise<WorkflowStartResult> {
  return api.post<WorkflowStartResult>(`/api/v1/workflows/${encodeURIComponent(id)}/resume`);
}

export function cancelWorkflow(id: string): Promise<WorkflowStartResult> {
  return api.post<WorkflowStartResult>(`/api/v1/workflows/${encodeURIComponent(id)}/cancel`);
}
