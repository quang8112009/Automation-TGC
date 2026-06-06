/**
 * TimelineAgent — proactive, idempotent due-item reminders
 * (study-abroad-ai-advisor-suite, Requirement 15).
 *
 * Periodically (via the `study-timeline-sweep` job) scans not-done `DueItem`s
 * that have entered their reminder window and creates at most one pending
 * `Reminder` per `(dueItem, window)`. Idempotency is enforced at the DB level by
 * `ReminderLog @@unique(dueItemId, windowKey)`: a re-run over the same data
 * creates no duplicate reminders (Req 15.2, 15.4). A previously RESOLVED/
 * CANCELLED reminder belongs to its own window, so a genuinely NEW window
 * (a changed `dueAt` → a new `windowKey`) is free to remind again (Req 15.3).
 *
 * On creating a new `ReminderLog`, a notification is emitted to the responsible
 * user (the candidate's `assignedTo`) through the `Notification_Service` seam.
 * The entire reminder/notification step for each item is wrapped in try/catch so
 * any failure is swallowed best-effort and can NEVER break or roll back the
 * already-computed timeline (Req 15.5) — only successfully created reminders are
 * counted. Done items are never reminded (Req 15.6).
 *
 * _Requirements: 15.1, 15.2, 15.3, 15.5, 15.6_
 */
import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../oversight/notificationService';
import type { NotificationDraft } from '../oversight/fanout';
import { inReminderWindow } from './timelineComputer';
import type { DueItem } from './types';

/** One day in milliseconds. */
const MS_PER_DAY = 86_400_000;

/** Default lead time, in days, before a deadline at which to start reminding. */
const REMINDER_WINDOW_DAYS = 14;

/** A reminder candidate: its projected `DueItem`, its type, and its owner. */
interface ReminderCandidate {
  item: DueItem;
  dueItemType: 'APPLICATION' | 'VISA';
  /** Candidate the item belongs to (used to resolve the responsible user). */
  candidateId: string;
}

/** Narrow an unknown error to a Prisma unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

export class TimelineAgent {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications?: NotificationService,
    private readonly windowDays: number = REMINDER_WINDOW_DAYS,
  ) {}

  /**
   * Scan not-done due items inside their reminder window and create idempotent
   * reminders. Returns the number of reminders successfully created on this run
   * (0 on a redundant re-run — Req 15.4).
   *
   * @param now Reference instant for the reminder-window calculation.
   */
  async sweepDueReminders(now: Date): Promise<{ created: number }> {
    const candidates = await this.loadWindowCandidates(now);
    if (candidates.length === 0) return { created: 0 };

    const ownerByCandidate = await this.resolveResponsibleUsers(candidates);

    let created = 0;
    for (const candidate of candidates) {
      // Each item's reminder/notification is isolated: any failure is swallowed
      // so it never breaks the sweep or rolls back the timeline (Req 15.5).
      try {
        const didCreate = await this.remindOnce(candidate, ownerByCandidate.get(candidate.candidateId) ?? null);
        if (didCreate) created += 1;
      } catch {
        // Best-effort: swallow ANY failure (DB, notification, realtime) for this
        // item and continue with the rest (Req 15.5). Intentionally not rethrown.
      }
    }

    return { created };
  }

  /**
   * Load all not-done `ApplicationDueItem`s and `VisaTask`s whose deadline falls
   * within the reminder window, projected into `DueItem`s. Done items are never
   * loaded (Req 15.6); `inReminderWindow` is the precise membership predicate.
   */
  private async loadWindowCandidates(now: Date): Promise<ReminderCandidate[]> {
    const windowEnd = new Date(now.getTime() + this.windowDays * MS_PER_DAY);

    const [dueRows, taskRows] = await Promise.all([
      this.prisma.applicationDueItem.findMany({
        where: { done: false, dueAt: { gte: now, lte: windowEnd } },
        select: {
          id: true,
          caseId: true,
          code: true,
          label: true,
          dueAt: true,
          done: true,
          case: { select: { candidateId: true } },
        },
      }),
      this.prisma.visaTask.findMany({
        where: { status: { not: 'DONE' }, dueAt: { gte: now, lte: windowEnd } },
        select: {
          id: true,
          caseId: true,
          code: true,
          label: true,
          dueAt: true,
          status: true,
          case: { select: { candidateId: true } },
        },
      }),
    ]);

    const candidates: ReminderCandidate[] = [];

    for (const r of dueRows) {
      const item: DueItem = {
        id: r.id,
        caseId: r.caseId,
        caseType: 'APPLICATION',
        code: r.code,
        label: r.label,
        dueAt: r.dueAt,
        done: r.done,
      };
      if (inReminderWindow(item, now, this.windowDays)) {
        candidates.push({ item, dueItemType: 'APPLICATION', candidateId: r.case.candidateId });
      }
    }

    for (const r of taskRows) {
      const item: DueItem = {
        id: r.id,
        caseId: r.caseId,
        caseType: 'VISA',
        code: r.code,
        label: r.label,
        dueAt: r.dueAt,
        done: r.status === 'DONE',
      };
      if (inReminderWindow(item, now, this.windowDays)) {
        candidates.push({ item, dueItemType: 'VISA', candidateId: r.case.candidateId });
      }
    }

    return candidates;
  }

  /** Batch-resolve each distinct candidate's responsible user (`assignedTo`). */
  private async resolveResponsibleUsers(
    candidates: readonly ReminderCandidate[],
  ): Promise<Map<string, string | null>> {
    const ids = [...new Set(candidates.map((c) => c.candidateId))];
    const rows = await this.prisma.candidateProfile.findMany({
      where: { id: { in: ids } },
      select: { id: true, assignedTo: true },
    });
    return new Map(rows.map((row) => [row.id, row.assignedTo ?? null]));
  }

  /**
   * Create exactly one reminder for an item's current window, idempotently.
   *
   * Returns `true` only when a brand-new `ReminderLog` row is created. Skips
   * (returns `false`) when a row already exists for `(dueItemId, windowKey)` —
   * whether PENDING (Req 15.2) or already RESOLVED/CANCELLED for this same
   * window — and treats a unique-constraint race as already-reminded.
   */
  private async remindOnce(candidate: ReminderCandidate, responsibleUserId: string | null): Promise<boolean> {
    const { item, dueItemType } = candidate;
    // `dueAt` is guaranteed non-null here (inReminderWindow rejects null).
    const dueAt = item.dueAt as Date;
    const windowKey = this.windowKeyFor(dueAt);

    // Existing row for this window occupies the unique slot: PENDING → already
    // reminded (Req 15.2); RESOLVED/CANCELLED → this window was handled, so a
    // fresh reminder waits for a NEW window/windowKey (Req 15.3). Either way skip.
    const existing = await this.prisma.reminderLog.findUnique({
      where: { dueItemId_windowKey: { dueItemId: item.id, windowKey } },
      select: { id: true },
    });
    if (existing) return false;

    let reminder: { id: string };
    try {
      reminder = await this.prisma.reminderLog.create({
        data: {
          dueItemId: item.id,
          dueItemType,
          windowKey,
          status: 'PENDING',
        },
        select: { id: true },
      });
    } catch (err) {
      // Lost the race to a concurrent sweep: the unique constraint means another
      // reminder already exists for this window → treat as already-reminded.
      if (isUniqueViolation(err)) return false;
      throw err;
    }

    // Best-effort notification to the responsible user; failure here must not
    // undo the created reminder (the outer try/catch already isolates it).
    await this.notifyResponsible(reminder.id, item, responsibleUserId);
    return true;
  }

  /**
   * Emit a reminder notification to the responsible user via the
   * `Notification_Service` seam. No-op when there is no responsible user or no
   * notification service is wired (the reminder still counts as created).
   */
  private async notifyResponsible(
    notificationRefId: string,
    item: DueItem,
    responsibleUserId: string | null,
  ): Promise<void> {
    void notificationRefId;
    if (!this.notifications || !responsibleUserId) return;

    const dueLabel = item.dueAt ? item.dueAt.toISOString().slice(0, 10) : '';
    const draft: NotificationDraft = {
      recipientUserId: responsibleUserId,
      kind: 'ACTIVITY',
      message: `Sắp đến hạn: "${item.label}" (hạn ${dueLabel}).`,
      refType: 'due_item',
      refId: item.id,
    };
    await this.notifications.createForAdmins([draft], {
      action: 'DUE_ITEM_REMINDER',
      targetType: 'due_item',
      targetId: item.id,
    });
  }

  /**
   * Deterministic reminder-window key for a deadline: its UTC calendar date
   * (`YYYY-MM-DD`). A changed `dueAt` yields a new key, which is what allows a
   * fresh reminder for a genuinely new window (Req 15.3).
   */
  private windowKeyFor(dueAt: Date): string {
    return dueAt.toISOString().slice(0, 10);
  }
}
