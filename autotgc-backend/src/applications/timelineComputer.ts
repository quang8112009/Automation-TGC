/**
 * Timeline_Computer — pure, framework-free timeline merge/sort core
 * (study-abroad-ai-advisor-suite, Requirement 14).
 *
 * Mirrors the pure-logic style of `analytics/scoring.ts` and
 * `recruitment/documents/completion.ts`: no Prisma/Fastify, deterministic, and
 * directly property-testable. The caller (`ApplicationService.timeline`) merges
 * `DueItem`s from ALL of a candidate's `ApplicationCase` + `VisaCase` records and
 * passes them here for a stable, set-preserving ordering.
 *
 * _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_
 * _Properties: 6_
 */
import type { DueItem } from './types';

/** One day in milliseconds, used for the reminder-window calculation. */
const MS_PER_DAY = 86_400_000;

/**
 * Deterministic lexicographic string comparison by UTF-16 code unit.
 *
 * Locale-independent (unlike `String.prototype.localeCompare`) so the ordering
 * is identical across environments — a prerequisite for determinism (Req 14.2).
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Total, deterministic order over `DueItem`s:
 *
 * 1. Dated items (`dueAt !== null`) sort before undated items (`dueAt === null`)
 *    (Req 14.5).
 * 2. Among dated items, earlier `dueAt` first (ascending) (Req 14.4).
 * 3. Ties (equal `dueAt`, or both undated) break by `code`, then by `id`
 *    — a stable, deterministic secondary criterion (Req 14.4, 14.5, 14.6).
 */
function compareDueItems(a: DueItem, b: DueItem): number {
  const aTime = a.dueAt === null ? null : a.dueAt.getTime();
  const bTime = b.dueAt === null ? null : b.dueAt.getTime();

  if (aTime !== null && bTime !== null) {
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  } else if (aTime !== null) {
    return -1; // a is dated, b is undetermined → a first (Req 14.5)
  } else if (bTime !== null) {
    return 1; // b is dated, a is undetermined → b first (Req 14.5)
  }

  // Equal deadlines, or both deadlines undetermined → deterministic tie-break.
  const byCode = compareStrings(a.code, b.code);
  if (byCode !== 0) return byCode;
  return compareStrings(a.id, b.id);
}

/**
 * Merge and sort the supplied due items into a single timeline.
 *
 * - Pure + deterministic: the same multiset of items and the same reference
 *   instant always produce the same ordered result (Req 14.2).
 * - SET-PRESERVING: the output is a permutation of the input — every input item
 *   appears exactly once (nothing added, lost, or duplicated) (Req 14.3).
 * - Ordered by `dueAt` ascending (earliest first) with a stable, deterministic
 *   tie-break of (`dueAt`, then `code`, then `id`) (Req 14.4).
 * - Items with `dueAt === null` sort AFTER all dated items, ordered by the
 *   deterministic secondary criterion (`code` then `id`) (Req 14.5).
 * - All-`null` deadlines is a valid case and is still stably ordered (Req 14.6).
 *
 * The input array is never mutated — a shallow copy is sorted (Req 14.2).
 *
 * @param items Due items merged from all of a candidate's cases.
 * @param now Reference instant for the timeline (reserved for the caller's
 *   reminder-window logic; ordering itself depends only on the items).
 */
export function computeTimeline(items: readonly DueItem[], now: Date): DueItem[] {
  void now;
  return items.slice().sort(compareDueItems);
}

/**
 * The next item to act on: the earliest not-done item in timeline order.
 *
 * Considers ONLY items that are not yet done (`done === false`); a completed
 * item is never returned (Req 14.7). Returns `undefined` when every item is
 * done. Deterministic for the same input and reference instant (Req 14.2).
 *
 * @param items Due items merged from all of a candidate's cases.
 * @param now Reference instant (kept consistent with `computeTimeline`).
 */
export function nextDue(items: readonly DueItem[], now: Date): DueItem | undefined {
  const pending = items.filter((item) => !item.done);
  return computeTimeline(pending, now)[0];
}

/**
 * Whether an item is currently inside its reminder window.
 *
 * `true` iff the item is not done, has a defined deadline, and that deadline is
 * within `windowDays` ahead of `now` — i.e. `0 <= (dueAt - now) <= windowDays * 86_400_000`.
 * Pure + deterministic for the same arguments.
 *
 * @param item The due item to test.
 * @param now Reference instant.
 * @param windowDays Lead time, in days, before the deadline.
 */
export function inReminderWindow(item: DueItem, now: Date, windowDays: number): boolean {
  if (item.done || item.dueAt === null) return false;
  const delta = item.dueAt.getTime() - now.getTime();
  return delta >= 0 && delta <= windowDays * MS_PER_DAY;
}
