/**
 * Real-time topic helpers (shared by the SSE and WebSocket transports).
 *
 * Pure, framework-free logic: role-based topic authorization (least privilege),
 * optional client-supplied topic filtering, and small typed readers for
 * narrowing untyped Fastify query input. No secrets ever pass through here.
 */
import type { DomainEvent, EventTopic } from '../infra/events';
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

/**
 * Per-recipient authorization for an individual event (defense-in-depth on top
 * of role/topic gating). SALES is assigned-only across the product, so a SALES
 * connection must only receive events that concern a resource assigned to that
 * same user. We read an owner hint from the event payload
 * (`assignedTo` / `recipientUserId`):
 *
 *  - ADMIN receives everything (subject to `shouldForward`).
 *  - SALES receives an event ONLY when the payload's owner matches the
 *    connection's userId. When the payload carries NO owner field at all we
 *    fail closed for SALES (an unscoped lead/notification could belong to
 *    anyone), preventing cross-tenant leakage over the realtime channel.
 *
 * Pure and deterministic — no I/O.
 */
export function isEventForRecipient(
  role: Role,
  userId: string,
  event: Pick<DomainEvent, 'payload'>,
): boolean {
  if (role === 'ADMIN') return true;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const owner =
    typeof payload.assignedTo === 'string'
      ? payload.assignedTo
      : typeof payload.recipientUserId === 'string'
        ? payload.recipientUserId
        : undefined;

  // SALES: only receive events explicitly owned by this user. No owner => deny.
  return owner !== undefined && owner === userId;
}

/** Read a single string-valued key from an untyped Fastify query object. */
export function readQueryString(query: unknown, key: string): string | undefined {
  if (query && typeof query === 'object' && key in query) {
    const value = (query as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
