/**
 * Property + integration tests for behavior-based follow-up (Feature 3): the
 * pure `followUpEngine` and the `FollowUpService` (in-memory Prisma + recording
 * sender, fixed clock).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';

import { isDropOff, buildFollowUpMessage, DROP_OFF_DAYS } from '../src/intake/followUpEngine';
import { FollowUpService } from '../src/intake/followUpService';
import type { ChannelSender, IntakeChannelValue } from '../src/intake/intakeService';

const NOW = new Date('2025-06-10T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('followUpEngine — pure', () => {
  it('isDropOff true only for ACTIVE + no open follow-up + silent >= threshold', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ACTIVE', 'COMPLETED', 'HANDED_OFF', 'ABANDONED'),
        fc.integer({ min: 0, max: 30 }),
        fc.boolean(),
        (status, ageDays, hasOpen) => {
          const result = isDropOff(
            { status, lastInboundAt: daysAgo(ageDays), hasOpenFollowUp: hasOpen },
            NOW,
          );
          const expected = status === 'ACTIVE' && !hasOpen && ageDays >= DROP_OFF_DAYS;
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never throws and is false when lastInboundAt is null', () => {
    expect(isDropOff({ status: 'ACTIVE', lastInboundAt: null, hasOpenFollowUp: false }, NOW)).toBe(false);
  });

  it('buildFollowUpMessage includes the topic when given, and a name fallback when blank', () => {
    const withTopic = buildFollowUpMessage({ name: 'Quân', topic: 'ĐH Tokyo' });
    expect(withTopic).toContain('Quân');
    expect(withTopic).toContain('ĐH Tokyo');
    const noName = buildFollowUpMessage({ name: '', topic: '' });
    expect(noName).toContain('bạn');
  });
});

// --- service ----------------------------------------------------------------

interface ConvoRow {
  id: string;
  channel: string;
  externalUserId: string;
  displayName: string | null;
  status: string;
  collected: Record<string, unknown>;
  lastInboundAt: Date | null;
  leadId: string | null;
  candidateId: string | null;
}
interface TaskRow {
  id: string;
  conversationId: string | null;
  channel: string;
  externalUserId: string;
  message: string;
  status: string;
  dueAt: Date;
  sentAt: Date | null;
}

function makePrisma(convos: ConvoRow[]): { prisma: PrismaClient; tasks: TaskRow[] } {
  const tasks: TaskRow[] = [];
  let seq = 0;
  const prisma = {
    intakeConversation: {
      findMany: async (args?: { where?: { status?: string } }) =>
        convos.filter((c) => !args?.where?.status || c.status === args.where.status),
    },
    followUpTask: {
      count: async (args: { where: { conversationId?: string; status?: { in: string[] } } }) =>
        tasks.filter(
          (t) =>
            (args.where.conversationId === undefined || t.conversationId === args.where.conversationId) &&
            (!args.where.status || args.where.status.in.includes(t.status)),
        ).length,
      create: async (args: { data: Record<string, unknown> }) => {
        const d = args.data as Partial<TaskRow>;
        const row: TaskRow = {
          id: `task-${++seq}`,
          conversationId: (d.conversationId as string | null) ?? null,
          channel: d.channel as string,
          externalUserId: d.externalUserId as string,
          message: (d.message as string) ?? '',
          status: (d.status as string) ?? 'PENDING',
          dueAt: (d.dueAt as Date) ?? NOW,
          sentAt: null,
        };
        tasks.push(row);
        return row;
      },
      findMany: async (args: { where?: { status?: string; dueAt?: { lte: Date } }; take?: number }) => {
        let rows = tasks.filter((t) => !args.where?.status || t.status === args.where.status);
        if (args.where?.dueAt?.lte) rows = rows.filter((t) => t.dueAt.getTime() <= args.where!.dueAt!.lte.getTime());
        return rows.slice(0, args.take ?? rows.length);
      },
      findUnique: async (args: { where: { id: string } }) => tasks.find((t) => t.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const t = tasks.find((x) => x.id === args.where.id)!;
        Object.assign(t, args.data);
        return t;
      },
      count2: undefined,
    },
  } as unknown as PrismaClient;
  return { prisma, tasks };
}

class RecordingSender implements ChannelSender {
  sent: string[] = [];
  constructor(private readonly fail = false) {}
  async send(_c: IntakeChannelValue, _u: string, text: string): Promise<void> {
    if (this.fail) throw new Error('send failed');
    this.sent.push(text);
  }
}

function convo(over: Partial<ConvoRow> & { id: string }): ConvoRow {
  return {
    id: over.id,
    channel: over.channel ?? 'ZALO',
    externalUserId: over.externalUserId ?? `u-${over.id}`,
    displayName: over.displayName ?? 'Quân',
    status: over.status ?? 'ACTIVE',
    collected: over.collected ?? { desiredMarket: 'Nhật Bản' },
    lastInboundAt: over.lastInboundAt ?? daysAgo(5),
    leadId: over.leadId ?? null,
    candidateId: over.candidateId ?? null,
  };
}

describe('FollowUpService', () => {
  it('queues exactly one task for a 5-day-silent ACTIVE conversation', async () => {
    const { prisma, tasks } = makePrisma([convo({ id: 'c1' })]);
    const svc = new FollowUpService(prisma, new RecordingSender(), () => NOW);
    const res = await svc.scanDropOffs();
    expect(res.queued).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].message.length).toBeGreaterThan(0);
  });

  it('never queues a COMPLETED conversation', async () => {
    const { prisma } = makePrisma([convo({ id: 'c1', status: 'COMPLETED' })]);
    const svc = new FollowUpService(prisma, new RecordingSender(), () => NOW);
    // findMany filters by ACTIVE, so nothing is scanned.
    const res = await svc.scanDropOffs();
    expect(res.queued).toBe(0);
  });

  it('does not double-queue on a second scan', async () => {
    const { prisma, tasks } = makePrisma([convo({ id: 'c1' })]);
    const svc = new FollowUpService(prisma, new RecordingSender(), () => NOW);
    await svc.scanDropOffs();
    const second = await svc.scanDropOffs();
    expect(second.queued).toBe(0);
    expect(tasks).toHaveLength(1);
  });

  it('sendDue sends PENDING due tasks and marks them SENT', async () => {
    const { prisma, tasks } = makePrisma([convo({ id: 'c1' })]);
    const sender = new RecordingSender();
    const svc = new FollowUpService(prisma, sender, () => NOW);
    await svc.scanDropOffs();
    const res = await svc.sendDue();
    expect(res.sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(tasks[0].status).toBe('SENT');
  });

  it('a sender that throws leaves the task PENDING (failed count 1)', async () => {
    const { prisma, tasks } = makePrisma([convo({ id: 'c1' })]);
    const svc = new FollowUpService(prisma, new RecordingSender(true), () => NOW);
    await svc.scanDropOffs();
    const res = await svc.sendDue();
    expect(res.failed).toBe(1);
    expect(tasks[0].status).toBe('PENDING');
  });
});
