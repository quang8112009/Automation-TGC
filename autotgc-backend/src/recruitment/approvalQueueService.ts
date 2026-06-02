/**
 * ApprovalQueueService — persists manual drag-and-drop priority for the
 * Operational Dashboard's Approval_Queue (DnD UX — Req 10.1, 10.3).
 *
 * The Approval_Queue is composed purely in `dashboard/assembler.buildApprovalQueue`
 * from the DRAFT `ContentDraft`s ∪ PENDING_REVIEW `LearningInsight`s. To support
 * manual prioritisation by dragging, each of those rows carries an additive
 * `priorityIndex` column (default 0). `reorder(req)` validates and applies a
 * `Reorder_Request` over the *combined* queue using the shared pure
 * `applyReorder`/`validateReorder` helpers, then writes the recomputed position
 * back to the matching `ContentDraft` / `LearningInsight` rows.
 *
 * RBAC (ADMIN-only write; SALES 403) is enforced at the route layer
 * (`feedback`/`update`), so this service is concerned only with validation and
 * persistence.
 */
import type { PrismaClient } from '@prisma/client';
import { applyReorder, validateReorder } from '../content/reorder';
import type { Reorderable, ReorderRequest } from '../content/reorder';

/** Which backing table a queue item belongs to. */
export type ApprovalQueueItemKind = 'DRAFT' | 'INSIGHT';

/** A reorderable Approval_Queue item tagged with its backing table. */
interface QueueItem extends Reorderable {
  id: string;
  orderIndex: number;
  kind: ApprovalQueueItemKind;
}

export interface ReorderResultRow {
  id: string;
  kind: ApprovalQueueItemKind;
  priorityIndex: number;
}

export class ApprovalQueueService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Read the current Approval_Queue membership: DRAFT `ContentDraft`s and
   * PENDING_REVIEW `LearningInsight`s, each carrying its current `priorityIndex`
   * (mapped onto `orderIndex` for the shared reorder helpers).
   */
  private async readQueueItems(): Promise<QueueItem[]> {
    const [drafts, insights] = await Promise.all([
      this.prisma.contentDraft.findMany({
        where: { status: 'DRAFT' },
        select: { id: true, priorityIndex: true },
      }),
      this.prisma.learningInsight.findMany({
        where: { insightStatus: 'PENDING_REVIEW' },
        select: { id: true, priorityIndex: true },
      }),
    ]);

    return [
      ...drafts.map((d) => ({ id: d.id, orderIndex: d.priorityIndex, kind: 'DRAFT' as const })),
      ...insights.map((i) => ({ id: i.id, orderIndex: i.priorityIndex, kind: 'INSIGHT' as const })),
    ];
  }

  /**
   * Apply a drag-and-drop `Reorder_Request` to the Approval_Queue and persist the
   * resulting `priorityIndex` on the matching `ContentDraft` / `LearningInsight`
   * rows (Req 10.1).
   *
   * - Rejects unknown/duplicate ids with a `ValidationError` (400) via
   *   `validateReorder` (set preservation — Req 10.2).
   * - Computes the new positions with the pure, idempotent `applyReorder`
   *   (Req 10.4) so the persisted `priorityIndex` matches the position the queue
   *   will render in (Req 10.3).
   * - All writes run in a single transaction so the queue is never left in a
   *   partially-reordered state.
   */
  async reorder(req: ReorderRequest): Promise<ReorderResultRow[]> {
    const items = await this.readQueueItems();

    // Set-preservation guard: unknown or duplicate ids -> ValidationError (400).
    validateReorder(items, req);

    const reordered = applyReorder(items, req);

    await this.prisma.$transaction(
      reordered.map((item) =>
        item.kind === 'DRAFT'
          ? this.prisma.contentDraft.update({
              where: { id: item.id },
              data: { priorityIndex: item.orderIndex },
            })
          : this.prisma.learningInsight.update({
              where: { id: item.id },
              data: { priorityIndex: item.orderIndex },
            }),
      ),
    );

    return reordered.map((item) => ({
      id: item.id,
      kind: item.kind,
      priorityIndex: item.orderIndex,
    }));
  }
}
