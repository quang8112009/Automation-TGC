/**
 * Schedule_Board — drag-and-drop reschedule + reorder for the content calendar
 * (DnD UX — Req 9.1–9.6).
 *
 * Three operations, all thin I/O wrappers over pure logic that lives elsewhere:
 * - `rescheduleItem` moves a single `ContentPlanItem` to a new target date.
 * - `reorderItems` persists a new `orderIndex` for a plan's items using the
 *   shared pure `applyReorder` (set-preservation + idempotence come from it).
 * - `rescheduleScheduledPost` delegates DIRECTLY to `CalendarService.reschedule`
 *   so the existing SCHEDULED-only (409) / future-only (400) guards are reused
 *   verbatim rather than duplicated.
 */
import type { ContentPlanItem, PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import { NotFoundError, ValidationError } from '../infra/errors';
import { CalendarService } from './calendarService';
import { applyReorder, validateReorder, type ReorderRequest } from './reorder';

export class ScheduleBoardService {
  private readonly calendar: CalendarService;

  constructor(
    private readonly prisma: PrismaClient,
    calendar?: CalendarService,
    clock: Clock = systemClock,
  ) {
    // Reuse the existing reschedule guards by delegating to CalendarService.
    this.calendar = calendar ?? new CalendarService(prisma, clock);
  }

  /**
   * Move a single `ContentPlanItem` to a new target date when dropped on a new
   * day (Req 9.1). Rejects an unparseable date with 400 and a missing item with
   * 404; the target date is otherwise persisted as-is.
   */
  async rescheduleItem(itemId: string, targetDate: Date): Promise<ContentPlanItem> {
    if (!(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) {
      throw new ValidationError('Invalid target date', 'INVALID_TARGET_DATE');
    }
    const existing = await this.prisma.contentPlanItem.findUnique({ where: { id: itemId } });
    if (!existing) {
      throw new NotFoundError('Content plan item not found', 'CONTENT_PLAN_ITEM_NOT_FOUND');
    }
    return this.prisma.contentPlanItem.update({
      where: { id: itemId },
      data: { targetDate },
    });
  }

  /**
   * Persist a new `orderIndex` for every `ContentPlanItem` in a plan from a
   * drag-and-drop gesture (Req 9.2, 9.3). Set-preservation and idempotence are
   * guaranteed by the pure `applyReorder`; `validateReorder` rejects unknown or
   * duplicate ids with 400 before anything is written.
   */
  async reorderItems(planId: string, req: ReorderRequest): Promise<ContentPlanItem[]> {
    const items = await this.prisma.contentPlanItem.findMany({
      where: { planId },
      orderBy: { orderIndex: 'asc' },
    });

    validateReorder(items, req);
    const reordered = applyReorder(items, req);

    // Persist the recomputed positions atomically so a partial failure can't
    // leave the plan with inconsistent ordering.
    await this.prisma.$transaction(
      reordered.map((item) =>
        this.prisma.contentPlanItem.update({
          where: { id: item.id },
          data: { orderIndex: item.orderIndex },
        }),
      ),
    );

    return reordered;
  }

  /**
   * Reschedule a `ScheduledPost` to a new time. Delegates DIRECTLY to
   * `CalendarService.reschedule`, reusing its SCHEDULED-only (409) and
   * future-only (400) guards (Req 9.4–9.6). No logic is duplicated here.
   */
  async rescheduleScheduledPost(
    postId: string,
    newTime: Date,
  ): Promise<{ id: string; scheduledAt: Date }> {
    return this.calendar.reschedule(postId, newTime);
  }
}
