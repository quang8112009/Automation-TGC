/**
 * Targeted coverage for two race/boundary paths the existing regression suites
 * leave open:
 *
 *  1. Lead webhook dedup RACE — the existing test covers the pre-check path
 *     (findUnique returns an existing lead before create). This covers the
 *     OTHER branch: the pre-check misses (concurrent delivery), create() loses
 *     the unique race with a P2002, and the service reads back the WINNER's row
 *     instead of throwing.
 *  2. Lockout auto-recovery EXACT boundary — `lockedUntil === now` must
 *     auto-recover (the guard is `lockedUntil <= now`), distinct from the
 *     already-tested past/future cases.
 *
 * Pure in-memory Prisma fakes, deterministic, no network.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { LeadService } from '../src/leads/leadService';
import { AuthService } from '../src/auth/authService';
import { JwtService } from '../src/auth/jwt';

const JWT_SECRET = 'idempotency-lockout-test-secret-long-enough-0123456789';

// ===========================================================================
// 1. Lead webhook dedup RACE (P2002 on create -> read back the winner).
// ===========================================================================
/**
 * A prisma fake where findUnique returns null on the FIRST call (so the pre-check
 * misses, simulating two concurrent deliveries), create() throws P2002 (the row
 * was inserted by the racing winner in between), and the post-failure findUnique
 * returns the winner's row.
 */
function racingLeadPrisma(winner: Record<string, unknown>): PrismaClient {
  let findUniqueCalls = 0;
  return {
    lead: {
      findUnique: async (_args: { where: { dedupKey?: string } }) => {
        findUniqueCalls += 1;
        // First call (pre-check) misses; subsequent call (post-P2002) hits.
        return findUniqueCalls === 1 ? null : winner;
      },
      create: async () => {
        const err = new Error('unique') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      },
    },
  } as unknown as PrismaClient;
}

describe('lead webhook dedup — race resolves to the winner row (P2002)', () => {
  it('returns the winner row instead of throwing when create loses the unique race', async () => {
    const winner = {
      leadId: 'lead-winner',
      status: 'NEW',
      source: 'facebook_leadgen',
      platform: 'facebook',
      dedupKey: 'lead:facebook:evt-9',
    };
    const svc = new LeadService(racingLeadPrisma(winner));
    const result = await svc.createFromWebhook(
      { source: 'facebook_leadgen', platform: 'facebook', contentPostId: 'post-1', unattributed: false },
      { name: 'A', phone: '1', email: 'a@b.co' },
      'lead:facebook:evt-9',
    );
    expect(result.leadId).toBe('lead-winner');
  });
});

// ===========================================================================
// 2. Lockout auto-recovery EXACT boundary (lockedUntil === now).
// ===========================================================================
interface UserRow {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: string;
  locked: boolean;
  lockedAt: Date | null;
  lockedUntil: Date | null;
  failedLoginCount: number;
  createdAt: Date;
}

function authPrisma(seed: UserRow[]): { prisma: PrismaClient; users: Map<string, UserRow> } {
  const users = new Map<string, UserRow>();
  for (const u of seed) users.set(u.id, { ...u });
  let seq = 0;
  const prisma = {
    userAccount: {
      count: async () => users.size,
      findUnique: async (args: { where: { id?: string; username?: string } }) => {
        const { id, username } = args.where;
        if (id !== undefined) return users.get(id) ?? null;
        if (username !== undefined) return [...users.values()].find((u) => u.username === username) ?? null;
        return null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = users.get(args.where.id);
        if (!row) throw new Error('no such user');
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    jwtSession: {
      create: async (args: { data: Record<string, unknown> }) => ({ sessionId: `sess-${(seq += 1)}`, ...args.data }),
    },
  } as unknown as PrismaClient;
  return { prisma, users };
}

describe('lockout auto-recovery — exact boundary (lockedUntil === now)', () => {
  it('auto-recovers when lockedUntil is exactly now (guard is <=), then verifies the password', async () => {
    const now = new Date();
    const seed: UserRow = {
      id: 'admin-1',
      username: 'admin',
      email: 'a@b.co',
      passwordHash: 'irrelevant-never-verified',
      role: 'ADMIN',
      locked: true,
      lockedAt: now,
      lockedUntil: now, // EXACTLY at the boundary
      failedLoginCount: 5,
      createdAt: now,
    };
    const { prisma, users } = authPrisma([seed]);
    const svc = new AuthService(prisma, new JwtService(JWT_SECRET, 24, 30), 5, 24, 30, 15);

    // The lock clears first (boundary <= now), then the bogus-hash verify fails
    // -> 401 with the counter re-incremented from the reset 0 to 1.
    await expect(svc.login('admin', 'whatever')).rejects.toMatchObject({ status: 401 });
    const row = users.get('admin-1');
    expect(row?.locked).toBe(false);
    expect(row?.lockedUntil).toBeNull();
    expect(row?.failedLoginCount).toBe(1);
  });
});
