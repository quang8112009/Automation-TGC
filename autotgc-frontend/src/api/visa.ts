/**
 * Typed wrappers for the Visa Smart Checklist + logistics + AI advisory
 * endpoints. A visa case auto-generates a per-country checklist with deadlines;
 * the advisory is AI-grounded (Gemini-optional, with a deterministic fallback).
 */
import { api } from '../lib/apiClient';
import type { LogisticsPlan, VisaAdvice, VisaCase, VisaCaseListResult, VisaTask } from '../lib/types';

export interface CreateVisaCaseInput {
  candidateId: string;
  country: string;
  visaType?: string;
  targetIntakeDate?: string;
  submissionDeadline?: string;
}

export function createVisaCase(input: CreateVisaCaseInput): Promise<VisaCase> {
  return api.post<VisaCase>('/api/v1/visa-cases', input);
}

export function listVisaCases(candidateId: string): Promise<VisaCaseListResult> {
  return api.get<VisaCaseListResult>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/visa-cases`,
  );
}

export function getVisaCase(id: string): Promise<VisaCase> {
  return api.get<VisaCase>(`/api/v1/visa-cases/${encodeURIComponent(id)}`);
}

export function getVisaAdvice(id: string): Promise<VisaAdvice> {
  return api.get<VisaAdvice>(`/api/v1/visa-cases/${encodeURIComponent(id)}/advice`);
}

export interface AddVisaTaskInput {
  label: string;
  category?: string;
  required?: boolean;
  dueAt?: string;
}

export function addVisaTask(caseId: string, input: AddVisaTaskInput): Promise<VisaTask> {
  return api.post<VisaTask>(`/api/v1/visa-cases/${encodeURIComponent(caseId)}/tasks`, input);
}

export interface UpdateVisaTaskInput {
  status?: string;
  dueAt?: string;
  note?: string;
}

export function updateVisaTask(taskId: string, input: UpdateVisaTaskInput): Promise<VisaTask> {
  return api.put<VisaTask>(`/api/v1/visa-tasks/${encodeURIComponent(taskId)}`, input);
}

export function generateLogistics(caseId: string): Promise<{ plan: LogisticsPlan }> {
  return api.post<{ plan: LogisticsPlan }>(
    `/api/v1/visa-cases/${encodeURIComponent(caseId)}/logistics/generate`,
  );
}

export interface LogisticsPatch {
  insuranceType?: string;
  pickupService?: string;
  housingType?: string;
  notes?: string;
}

export function updateLogistics(caseId: string, patch: LogisticsPatch): Promise<LogisticsPlan> {
  return api.put<LogisticsPlan>(
    `/api/v1/visa-cases/${encodeURIComponent(caseId)}/logistics`,
    patch,
  );
}
