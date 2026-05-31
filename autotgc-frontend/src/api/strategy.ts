import { api } from '../lib/apiClient';
import type {
  CalendarResult,
  ContentPersona,
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
