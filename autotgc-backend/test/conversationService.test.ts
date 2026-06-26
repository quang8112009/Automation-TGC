/**
 * Unit tests for ConversationService (`src/infra/conversationService.ts`) — the
 * grounded assistant's multi-turn memory. The security-critical behaviour is
 * OWNERSHIP: a conversation is private to its owner, and a foreign/missing id is
 * an indistinguishable 404. We also assert chronological history, the bounded
 * `recentHistory` window, and the USER/ASSISTANT → user/assistant mapping.
 *
 * Uses a small in-memory Prisma fake (no DB) covering exactly the operations the
 * service calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ConversationService,
  deriveTitle,
  clampHistoryLimit,
  DEFAULT_HISTORY_LIMIT,
  HISTORY_LIMIT_CEILING,
} from '../src/infra/conversationService';
import { NotFoundError } from '../src/infra/errors';

interface ConvRow {
  id: string;
  userId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface MsgRow {
  id: string;
  conversationId: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  aiGenerated: boolean;
  createdAt: Date;
}

/** Build an in-memory Prisma fake for the two assistant-memory tables. */
function makePrismaFake() {
  const convs: ConvRow[] = [];
  const msgs: MsgRow[] = [];
  let seq = 0;
  const now = (): Date => new Date(Date.now() + seq++); // strictly increasing timestamps

  const prisma = {
    assistantConversation: {
      create: async ({ data }: { data: { userId: string; title: string | null } }) => {
        const row: ConvRow = { id: `c${convs.length + 1}`, userId: data.userId, title: data.title, createdAt: now(), updatedAt: now() };
        convs.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: { where: { userId: string }; orderBy: { updatedAt: 'desc' } }) => {
        void orderBy;
        return convs.filter((c) => c.userId === where.userId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      },
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        convs.find((c) => c.id === where.id && c.userId === where.userId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { updatedAt: Date } }) => {
        const row = convs.find((c) => c.id === where.id);
        if (row) row.updatedAt = data.updatedAt;
        return row;
      },
    },
    assistantMessage: {
      create: async ({ data }: { data: Omit<MsgRow, 'id' | 'createdAt'> }) => {
        const row: MsgRow = { id: `m${msgs.length + 1}`, createdAt: now(), ...data };
        msgs.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take }: { where: { conversationId: string }; orderBy: { createdAt: 'asc' | 'desc' }; take?: number }) => {
        const list = msgs
          .filter((m) => m.conversationId === where.conversationId)
          .sort((a, b) => (orderBy.createdAt === 'asc' ? a.createdAt.getTime() - b.createdAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime()));
        return take ? list.slice(0, take) : list;
      },
    },
    // Execute the array of already-started operations (mirrors Prisma's
    // sequential array transaction closely enough for these unit tests).
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaClient;

  return prisma;
}

describe('assistant-memory — pure helpers', () => {
  it('deriveTitle collapses whitespace and truncates long seeds', () => {
    expect(deriveTitle('  hello   world  ')).toBe('hello world');
    expect(deriveTitle('')).toBe('Hội thoại mới');
    expect(deriveTitle('x'.repeat(200)).endsWith('…')).toBe(true);
  });

  it('clampHistoryLimit clamps into [1, ceiling] with a default', () => {
    expect(clampHistoryLimit(undefined)).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit(Number.NaN)).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit(0)).toBe(1);
    expect(clampHistoryLimit(-5)).toBe(1);
    expect(clampHistoryLimit(9999)).toBe(HISTORY_LIMIT_CEILING);
    expect(clampHistoryLimit(7)).toBe(7);
  });
});

describe('assistant-memory — ConversationService ownership + history', () => {
  let prisma: PrismaClient;
  let svc: ConversationService;
  beforeEach(() => {
    prisma = makePrismaFake();
    svc = new ConversationService(prisma);
  });

  it('create + list returns only the owner threads', async () => {
    const a = await svc.create('user-A', 'My thread');
    await svc.create('user-B', 'Other thread');
    const listA = await svc.list('user-A');
    expect(listA.map((c) => c.id)).toEqual([a.id]);
    expect(listA[0].title).toBe('My thread');
  });

  it('getOwned throws 404 for a foreign or missing conversation', async () => {
    const a = await svc.create('user-A');
    await expect(svc.getOwned('user-B', a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.getOwned('user-A', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.getOwned('user-A', a.id)).resolves.toMatchObject({ id: a.id });
  });

  it('append + getMessages preserve chronological order; foreign access is 404', async () => {
    const a = await svc.create('user-A');
    await svc.append('user-A', a.id, 'USER', 'cau hoi 1', false);
    await svc.append('user-A', a.id, 'ASSISTANT', 'tra loi 1', true);
    const msgs = await svc.getMessages('user-A', a.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['USER', 'cau hoi 1'],
      ['ASSISTANT', 'tra loi 1'],
    ]);
    expect(msgs[1].aiGenerated).toBe(true);
    await expect(svc.getMessages('user-B', a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.append('user-B', a.id, 'USER', 'hack', false)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('appendTurn writes both USER+ASSISTANT atomically and is owner-gated', async () => {
    const a = await svc.create('user-A');
    await svc.appendTurn('user-A', a.id, 'cau hoi', 'tra loi', true);
    const msgs = await svc.getMessages('user-A', a.id);
    expect(msgs.map((m) => [m.role, m.content, m.aiGenerated])).toEqual([
      ['USER', 'cau hoi', false],
      ['ASSISTANT', 'tra loi', true],
    ]);
    await expect(svc.appendTurn('user-B', a.id, 'q', 'a', false)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('recentHistory returns a bounded, chronological ChatMessage[] with mapped roles', async () => {
    const a = await svc.create('user-A');
    for (let i = 0; i < 5; i += 1) {
      await svc.append('user-A', a.id, 'USER', `q${i}`, false);
      await svc.append('user-A', a.id, 'ASSISTANT', `a${i}`, true);
    }
    const hist = await svc.recentHistory('user-A', a.id, 4);
    expect(hist).toHaveLength(4);
    // The 4 most-recent turns, restored to chronological order.
    expect(hist.map((m) => m.content)).toEqual(['q3', 'a3', 'q4', 'a4']);
    expect(hist.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
