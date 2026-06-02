import { api } from '../lib/apiClient';
import type {
  CalendarResult,
  ContentPersona,
  ContentPlanItem,
  PersonaRecommendation,
} from '../lib/types';

export interface PersonaInput {
  domainName?: string;
  personaName?: string;
  age?: string;
  interests?: string;
  targetNeeds?: string;
  painPoints?: string;
  toneOfVoice?: string;
}

export function createPersona(input: PersonaInput): Promise<ContentPersona> {
  return api.post<ContentPersona>('/api/strategy/persona', input);
}

/** A persona row enriched with its domain name (from the list/get endpoints). */
export type PersonaWithDomain = ContentPersona & { domainName: string };

export interface PersonaListResult {
  items: PersonaWithDomain[];
  total: number;
  page: number;
  limit: number;
}

/** List saved personas (newest first), optionally filtered by domain name. */
export function listPersonas(domainName?: string): Promise<PersonaListResult> {
  return api.get<PersonaListResult>('/api/strategy/personas', { domainName });
}

export function updatePersona(
  id: string,
  input: Omit<PersonaInput, 'domainName'>,
): Promise<ContentPersona> {
  return api.put<ContentPersona>(`/api/strategy/persona/${encodeURIComponent(id)}`, input);
}

/**
 * The backend uses the :id segment as the domain name when no domainName query
 * is supplied. We pass the domain name in both positions for clarity.
 */
export function getRecommendations(domainName: string): Promise<PersonaRecommendation> {
  return api.get<PersonaRecommendation>(
    `/api/strategy/persona/${encodeURIComponent(domainName)}/recommendations`,
    { domainName },
  );
}

export function getCalendar(
  view: 'month' | 'week' | 'day',
  date?: string,
): Promise<CalendarResult> {
  return api.get<CalendarResult>('/api/strategy/calendar', { view, date });
}

export function rescheduleCalendarItem(
  id: string,
  scheduledAt: string,
): Promise<{ id: string; scheduledAt: string }> {
  return api.put<{ id: string; scheduledAt: string }>(
    `/api/strategy/calendar/${encodeURIComponent(id)}/reschedule`,
    { scheduledAt },
  );
}

export function getAiContext(): Promise<Record<string, unknown>> {
  return api.get<Record<string, unknown>>('/api/strategy/ai-context');
}

// ---- Schedule_Board drag-and-drop (Req 9.1, 9.2) ---------------------------

/**
 * Persist a new order for a plan's ContentPlanItems after a drag-and-drop
 * reorder. `orderedIds` is the desired full ordering; the backend rewrites each
 * item's `orderIndex` to match (set-preserving + idempotent) and returns the
 * updated items. Unknown/duplicate ids surface as a 400 ApiError.
 */
export function reorderContentPlanItems(
  planId: string,
  orderedIds: string[],
): Promise<{ items: ContentPlanItem[] }> {
  return api.post<{ items: ContentPlanItem[] }>(
    `/api/v1/content-plans/${encodeURIComponent(planId)}/reorder`,
    { orderedIds },
  );
}

/**
 * Move a single ContentPlanItem to a new target date when dropped on another
 * day. `targetDate` is an ISO string; an invalid date surfaces as a 400.
 */
export function rescheduleContentPlanItem(
  id: string,
  targetDate: string,
): Promise<ContentPlanItem> {
  return api.put<ContentPlanItem>(
    `/api/v1/content-plan-items/${encodeURIComponent(id)}/reschedule`,
    { targetDate },
  );
}
