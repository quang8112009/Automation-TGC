/**
 * Real-time topic helpers (shared by the SSE and WebSocket transports).
 *
 * Pure, framework-free logic: role-based topic authorization (least privilege),
 * optional client-supplied topic filtering, and small typed readers for
 * narrowing untyped Fastify query input. No secrets ever pass through here.
 */
import type { EventTopic } from '../infra/events';
import type { Role } from '../auth/jwt';

/** Every topic the event bus can emit. */
export const ALL_TOPICS: readonly EventTopic[] = [
  'draft',
  'scheduled_post',
  'insight',
  'lead',
  'token_alert',
  'workflow',
  'notification',
];

/**
 * Topics a SALES principal is allowed to receive. Respects least privilege:
 * SALES only sees lead activity and generic notifications; everything else is
 * ADMIN-only.
 */
export const SALES_TOPICS: readonly EventTopic[] = ['lead', 'notification'];

/** Whether a principal with `role` may receive events on `topic`. */
export function isTopicAllowedForRole(role: Role, topic: EventTopic): boolean {
  if (role === 'ADMIN') return true;
  return SALES_TOPICS.includes(topic);
}

/** Narrow an unknown value to a known EventTopic. */
function isEventTopic(value: string): value is EventTopic {
  return (ALL_TOPICS as readonly string[]).includes(value);
}

/**
 * Parse a comma-separated `topics` filter (e.g. "draft,lead") into a set of
 * valid topics. Returns null when no usable filter was supplied, meaning "no
 * client-side filter" (role policy still applies).
 */
export function parseTopicFilter(raw: string | undefined): ReadonlySet<EventTopic> | null {
  if (!raw) return null;
  const set = new Set<EventTopic>();
  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (candidate.length > 0 && isEventTopic(candidate)) {
      set.add(candidate);
    }
  }
  return set.size > 0 ? set : null;
}

/**
 * Decide whether an event on `topic` should be forwarded to a connection with
 * the given role and optional client filter.
 */
export function shouldForward(
  role: Role,
  topic: EventTopic,
  filter: ReadonlySet<EventTopic> | null,
): boolean {
  if (!isTopicAllowedForRole(role, topic)) return false;
  if (filter && !filter.has(topic)) return false;
  return true;
}

/** Read a single string-valued key from an untyped Fastify query object. */
export function readQueryString(query: unknown, key: string): string | undefined {
  if (query && typeof query === 'object' && key in query) {
    const value = (query as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
