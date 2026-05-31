/**
 * Typed wrappers for the marketing autopilot endpoints (customer: Thanh Giang —
 * XKLĐ). The run executes research → plan → generate → review_gate → schedule →
 * summary and PAUSES at `review_gate` (status WAITING_APPROVAL) until approved.
 *
 * GET /runs/:id returns a WorkflowRun (with its steps) — the same shape the
 * Workflows page already consumes.
 */
import { api } from '../lib/apiClient';
import type { AutopilotStartResult, WorkflowRun } from '../lib/types';

export interface AutopilotRunInput {
  market: string;
  objective: string;
  periodFrom: string;
  periodTo: string;
  channels?: string[];
  domainName?: string;
  personaIds?: string[];
  requireApproval?: boolean;
}

export function startAutopilot(input: AutopilotRunInput): Promise<AutopilotStartResult> {
  return api.post<AutopilotStartResult>('/api/v1/autopilot/run', input);
}

export function getAutopilotRun(id: string): Promise<WorkflowRun> {
  return api.get<WorkflowRun>(`/api/v1/autopilot/runs/${encodeURIComponent(id)}`);
}

export function approveAutopilotRun(id: string): Promise<AutopilotStartResult> {
  return api.post<AutopilotStartResult>(`/api/v1/autopilot/runs/${encodeURIComponent(id)}/approve`);
}

export function cancelAutopilotRun(id: string): Promise<AutopilotStartResult> {
  return api.post<AutopilotStartResult>(`/api/v1/autopilot/runs/${encodeURIComponent(id)}/cancel`);
}
