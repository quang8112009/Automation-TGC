/**
 * Shared pure drag-and-drop reorder logic (DnD UX — Req 9.2, 9.3, 10.1, 10.2, 10.4).
 *
 * Used by both Schedule_Board (`ContentPlanItem.orderIndex`) and Approval_Queue
 * (`ContentDraft`/`LearningInsight.priorityIndex`). Framework-free and pure so it
 * can be property-tested directly (Design §"Drag-and-drop reorder → reorder.ts",
 * Correctness Properties 12, 13).
 */
import { ValidationError } from '../infra/errors';

/** Desired order after a drag-and-drop gesture. */
export interface ReorderRequest {
  orderedIds: string[];
}

/** Anything with a stable id and a persisted ordering position. */
export interface Reorderable {
  id: string;
  orderIndex: number;
}

/**
 * Recompute `orderIndex` for a set of items from a `Reorder_Request`.
 *
 * Guarantees:
 * - **Set preservation:** the returned items have exactly the same id set as the
 *   input — nothing is added or removed (Req 9.3, 10.2).
 * - **Order reflects the request:** each item whose id appears in `orderedIds` is
 *   placed first, in `orderedIds` order, and gets `orderIndex` equal to its
 *   position (0..n-1); items absent from `orderedIds` keep their relative input
 *   order and are appended after (Req 9.2, 10.1).
 * - **Idempotence:** `applyReorder(applyReorder(items, req), req)` deep-equals
 *   `applyReorder(items, req)` for any input, even when `orderedIds` contains
 *   unknown or duplicate ids (Req 10.4).
 *
 * Pure: input items are never mutated; new objects are returned preserving all
 * other fields of `T`.
 */
export function applyReorder<T extends Reorderable>(items: readonly T[], req: ReorderRequest): T[] {
  // First-occurrence rank for each id mentioned in the request; later duplicates
  // are ignored so a duplicated id does not create gaps or instability.
  const rank = new Map<string, number>();
  for (const id of req.orderedIds) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }

  const ranked: T[] = [];
  const remaining: T[] = [];
  for (const item of items) {
    if (rank.has(item.id)) ranked.push(item);
    else remaining.push(item);
  }

  // Items named in the request come first, sorted by their request rank; the rest
  // keep their original relative order. (Array.prototype.sort is stable on Node 20.)
  ranked.sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));

  const ordered = [...ranked, ...remaining];
  return ordered.map((item, index) => ({ ...item, orderIndex: index }));
}

/**
 * Validate a `Reorder_Request` against the current item set. Rejects with a
 * `ValidationError` (400) when `orderedIds` references an unknown id or contains
 * a duplicate id.
 */
export function validateReorder(items: readonly { id: string }[], req: ReorderRequest): void {
  const known = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  for (const id of req.orderedIds) {
    if (!known.has(id)) {
      throw new ValidationError(`Unknown id in reorder request: ${id}`, 'REORDER_UNKNOWN_ID');
    }
    if (seen.has(id)) {
      throw new ValidationError(`Duplicate id in reorder request: ${id}`, 'REORDER_DUPLICATE_ID');
    }
    seen.add(id);
  }
}
