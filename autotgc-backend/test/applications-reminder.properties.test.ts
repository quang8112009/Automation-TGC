/**
 * Property-based test for the study-abroad-ai-advisor-suite TimelineAgent
 * (Requirement 15 — proactive, idempotent due-item reminders).
 *
 * Isolated in its own file (per the design/tasks note) because it needs a
 * dedicated in-memory store that faithfully reproduces the DB-level idempotency
 * guard `ReminderLog @@unique(dueItemId, windowKey)`. External seams are faked:
 * the Prisma client implements ONLY the methods `TimelineAgent` actually calls,
 * and the `Notification_Service` is a no-op. The clock is injected so runs are
 * deterministic.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';

import { TimelineAgent } from '../src/applications/timelineAgent';
import type { NotificationService } from '../src/oversight/notificationService';

// --- shared constants --------------------------------------------------------

/** One day in milliseconds (mirrors TimelineAgent's internal constant). */
const MS_PER_DAY = 86_400_000;

/** Default reminder lead time (14 days) expressed in milliseconds. */
const REMINDER_WINDOW_MS = 14 * MS_PER_DAY;

// --- in-memory Prisma fake ---------------------------------------------------
// Only the model methods TimelineAgent.sweepDueReminders touches are implemented:
//   applicationDueItem.findMany, visaTask.findMany, candidateProfile.findMany,
//   reminderLog.findUnique (composite key), reminderLog.create.
// reminderLog enforces @@unique(dueItemId, windowKey): a duplicate insert throws
// an error carrying Prisma's P2002 code, exactly like the real DB constraint.

interface DueItemRow {
  id: string;
  caseId: string;
  code: string;
  label: string;
  dueAt: Date | null;
  done: boolean;
  case: { candidateId: string };
}

interface CandidateRow {
  id: string;
  assignedTo: string | null;
}

interface ReminderLogRow {
  id: string;
  dueItemId: string;
  dueItemType: string;
  windowKey: string;
  status: string;
  notificationId: string | null;
  createdAt: Date;
}

interface FakeStore {
  dueItems: DueItemRow[];
  candidates: CandidateRow[];
  reminderLogs: ReminderLogRow[];
  prisma: PrismaClient;
}

/** Build a fresh in-memory store; `now` is the timestamp stamped on new rows. */
function makeFakeStore(now: Date): FakeStore {
  const dueItems: DueItemRow[] = [];
  const candidates: CandidateRow[] = [];
  const reminderLogs: ReminderLogRow[] = [];
  let seq = 0;

  const inDueAtRange = (dueAt: Date | null, range?: { gte?: Date; lte?: Date }): boolean => {
    if (!range) return true;
    if (dueAt === null) return false;
    const t = dueAt.getTime();
    if (range.gte && t < range.gte.getTime()) return false;
    if (range.lte && t > range.lte.getTime()) return false;
    return true;
  };

  const prisma = {
    applicationDueItem: {
      findMany: async (args?: { where?: { done?: boolean; dueAt?: { gte?: Date; lte?: Date } } }) => {
        const where = args?.where ?? {};
        return dueItems
          .filter((r) => {
            if (where.done !== undefined && r.done !== where.done) return false;
            if (!inDueAtRange(r.dueAt, where.dueAt)) return false;
            return true;
          })
          .map((r) => ({
            id: r.id,
            caseId: r.caseId,
            code: r.code,
            label: r.label,
            dueAt: r.dueAt,
            done: r.done,
            case: { candidateId: r.case.candidateId },
          }));
      },
    },
    // No VisaTasks in this property; the agent still queries the model.
    visaTask: {
      findMany: async () => [],
    },
    candidateProfile: {
      findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
        const ids = new Set(args?.where?.id?.in ?? []);
        return candidates
          .filter((c) => ids.has(c.id))
          .map((c) => ({ id: c.id, assignedTo: c.assignedTo }));
      },
    },
    reminderLog: {
      findUnique: async (args: {
        where: { dueItemId_windowKey: { dueItemId: string; windowKey: string } };
      }) => {
        const { dueItemId, windowKey } = args.where.dueItemId_windowKey;
        const row = reminderLogs.find((r) => r.dueItemId === dueItemId && r.windowKey === windowKey);
        return row ? { id: row.id } : null;
      },
      create: async (args: {
        data: {
          dueItemId: string;
          dueItemType?: string;
          windowKey: string;
          status?: string;
          notificationId?: string | null;
        };
      }) => {
        const { dueItemId, windowKey } = args.data;
        // Enforce @@unique(dueItemId, windowKey) — duplicate → Prisma P2002.
        const duplicate = reminderLogs.some(
          (r) => r.dueItemId === dueItemId && r.windowKey === windowKey,
        );
        if (duplicate) {
          const err = new Error('Unique constraint failed on (dueItemId, windowKey)') as Error & {
            code?: string;
          };
          err.code = 'P2002';
          throw err;
        }
        const row: ReminderLogRow = {
          id: `rl_${++seq}`,
          dueItemId,
          dueItemType: args.data.dueItemType ?? 'APPLICATION',
          windowKey,
          status: args.data.status ?? 'PENDING',
          notificationId: args.data.notificationId ?? null,
          createdAt: now,
        };
        reminderLogs.push(row);
        return { id: row.id };
      },
    },
  } as unknown as PrismaClient;

  return { dueItems, candidates, reminderLogs, prisma };
}

/** No-op Notification_Service: never throws, returns nothing meaningful. */
const noopNotifications = {
  createForAdmins: async () => 0,
} as unknown as NotificationService;

// =============================================================================
// TimelineAgent reminder idempotency
// =============================================================================

describe('study-abroad-ai-advisor-suite properties (timeline reminders)', () => {
  // Feature: study-abroad-ai-advisor-suite, Property 7: Tạo Reminder là lũy đẳng theo Due_Item
  // Validates Requirements 15.2, 15.4, 19.6.
  it('Property 7: creating reminders is idempotent per Due_Item', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A set of not-done due items, each with a deadline inside the 14-day
        // reminder window (offset in [0, 14d]) so it qualifies, and each linked
        // to a candidate that has an assigned responsible user.
        fc.array(
          fc.record({
            offsetMs: fc.integer({ min: 0, max: REMINDER_WINDOW_MS }),
            assignedTo: fc.string({ minLength: 1, maxLength: 8 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (specs) => {
          const now = new Date('2025-01-01T00:00:00.000Z');
          const store = makeFakeStore(now);

          specs.forEach((spec, i) => {
            const candidateId = `cand_${i}`;
            store.candidates.push({ id: candidateId, assignedTo: spec.assignedTo });
            store.dueItems.push({
              id: `due_${i}`, // unique ids
              caseId: `case_${i}`,
              code: `CODE_${i}`,
              label: `Due item ${i}`,
              dueAt: new Date(now.getTime() + spec.offsetMs),
              done: false,
              case: { candidateId },
            });
          });

          // Every generated item is not-done and inside the window → qualifies.
          const qualifying = store.dueItems.length;
          const agent = new TimelineAgent(store.prisma, noopNotifications);

          // First sweep: exactly one reminder per qualifying due item (Req 15.2).
          const first = await agent.sweepDueReminders(now);
          expect(first.created).toBe(qualifying);

          // Second sweep over the same store: no new reminders (Req 15.4, 19.6).
          const second = await agent.sweepDueReminders(now);
          expect(second).toEqual({ created: 0 });

          // At most one PENDING ReminderLog per (dueItemId, windowKey).
          const pendingPerWindow = new Map<string, number>();
          for (const r of store.reminderLogs) {
            if (r.status !== 'PENDING') continue;
            const key = `${r.dueItemId}\u0000${r.windowKey}`;
            pendingPerWindow.set(key, (pendingPerWindow.get(key) ?? 0) + 1);
          }
          for (const count of pendingPerWindow.values()) {
            expect(count).toBeLessThanOrEqual(1);
          }

          // No duplicates accumulated across the two runs.
          expect(store.reminderLogs.length).toBe(qualifying);
        },
      ),
      { numRuns: 100 },
    );
  });
});
