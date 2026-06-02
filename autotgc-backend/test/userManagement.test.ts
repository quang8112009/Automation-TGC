/**
 * Unit tests for UserManagementService (src/auth/userManagementService.ts) — the
 * ADMIN-only staff account manager (Requirements 5.1–5.8), plus a small
 * AuthService check for locked-account login (Req 5.10).
 *
 * Uses an in-memory Prisma fake backing the `userAccount` table. The fake keeps
 * rows in an id-keyed map and supports the slice the services touch:
 *   - findMany (orderBy createdAt asc),
 *   - findUnique by `id` OR by `username` (the unique fields the code queries),
 *   - create (stamps id + createdAt, defaults locked/failedLoginCount),
 *   - update (shallow-merges the provided data).
 *
 * Password handling is exercised for REAL via src/auth/password.ts (argon2):
 * `resetPassword` must persist a hash that `verifyPassword(hash, newPassword)`
 * accepts and that is NOT the plaintext. argon2 is intentionally slow, so the
 * password assertions use only a couple of examples and a generous timeout.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { UserManagementService } from '../src/auth/userManagementService';
import { AuthService } from '../src/auth/authService';
import { JwtService } from '../src/auth/jwt';
import { verifyPassword } from '../src/auth/password';
import { ConflictError, LockedError, ValidationError } from '../src/infra/errors';

/** A UserAccount row as stored by the in-memory fake. */
interface UserRow {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: string;
  locked: boolean;
  lockedAt: Date | null;
  failedLoginCount: number;
  createdAt: Date;
}

/** Options for seeding a user row; sensible auth defaults are filled in. */
function makeUser(seed: Partial<UserRow> & { id: string; username: string }): UserRow {
  return {
    email: `${seed.username}@example.com`,
    passwordHash: 'hash:placeholder',
    role: 'SALES',
    locked: false,
    lockedAt: null,
    failedLoginCount: 0,
    createdAt: new Date(Date.UTC(2024, 0, 1)),
    ...seed,
  } as UserRow;
}

/**
 * Build an in-memory Prisma fake seeded with the given user rows. `users`
 * exposes the live store so tests can assert against persisted rows.
 */
function fakePrisma(seed: UserRow[] = []): {
  prisma: PrismaClient;
  users: Map<string, UserRow>;
} {
  const users = new Map<string, UserRow>();
  for (const u of seed) users.set(u.id, { ...u });
  let seq = 0;

  const byWhere = (where: { id?: string; username?: string }): UserRow | undefined => {
    if (where.id !== undefined) return users.get(where.id);
    if (where.username !== undefined) {
      return [...users.values()].find((u) => u.username === where.username);
    }
    return undefined;
  };

  const prisma = {
    userAccount: {
      findMany: async (args?: { orderBy?: { createdAt?: 'asc' | 'desc' } }) => {
        const rows = [...users.values()];
        const dir = args?.orderBy?.createdAt ?? 'asc';
        rows.sort((a, b) =>
          dir === 'asc'
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return rows.map((r) => ({ ...r }));
      },
      findUnique: async (args: { where: { id?: string; username?: string } }) => {
        const row = byWhere(args.where);
        return row ? { ...row } : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const n = (seq += 1);
        const row: UserRow = {
          id: `user-${n}`,
          username: String(args.data.username),
          email: String(args.data.email),
          passwordHash: String(args.data.passwordHash),
          role: String(args.data.role ?? 'SALES'),
          locked: Boolean(args.data.locked ?? false),
          lockedAt: (args.data.lockedAt as Date | null) ?? null,
          failedLoginCount: Number(args.data.failedLoginCount ?? 0),
          createdAt: new Date(Date.UTC(2024, 0, 1) + n * 1000),
        };
        users.set(row.id, row);
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = users.get(args.where.id);
        if (!row) throw new Error('fake: update of missing row');
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    // Used by AuthService.login on success; harmless for the locked-account path.
    jwtSession: {
      create: async (args: { data: Record<string, unknown> }) => ({
        sessionId: 'sess-1',
        ...args.data,
      }),
    },
  } as unknown as PrismaClient;

  return { prisma, users };
}

describe('UserManagementService.list (Req 5.1)', () => {
  it('returns username/email/role/locked for every account', async () => {
    const { prisma } = fakePrisma([
      makeUser({ id: 'u-admin', username: 'admin', role: 'ADMIN', locked: false }),
      makeUser({ id: 'u-sales', username: 'sales', role: 'SALES', locked: true }),
    ]);
    const service = new UserManagementService(prisma);

    const list = await service.list();

    expect(list).toHaveLength(2);
    for (const view of list) {
      expect(Object.keys(view).sort()).toEqual(['email', 'id', 'locked', 'role', 'username'].sort());
    }
    const admin = list.find((u) => u.username === 'admin');
    expect(admin).toMatchObject({ email: 'admin@example.com', role: 'ADMIN', locked: false });
    const sales = list.find((u) => u.username === 'sales');
    expect(sales).toMatchObject({ role: 'SALES', locked: true });
  });
});

describe('UserManagementService.createSalesUser (Req 5.2, 5.3, 5.4)', () => {
  it('creates a SALES-role account (Req 5.2)', async () => {
    const { prisma, users } = fakePrisma();
    const service = new UserManagementService(prisma);

    const created = await service.createSalesUser({
      username: 'newsales',
      email: 'newsales@example.com',
      password: 'password123',
    });

    expect(created.role).toBe('SALES');
    expect(created.username).toBe('newsales');
    expect(created.locked).toBe(false);
    // Persisted with a hashed (non-plaintext) password.
    const stored = users.get(created.id)!;
    expect(stored.passwordHash).not.toBe('password123');
    expect(stored.role).toBe('SALES');
  });

  it('rejects a duplicate username with a 409 ConflictError (Req 5.3)', async () => {
    const { prisma } = fakePrisma([makeUser({ id: 'u-1', username: 'taken' })]);
    const service = new UserManagementService(prisma);

    const err = await service
      .createSalesUser({ username: 'taken', email: 'x@example.com', password: 'password123' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).status).toBe(409);
  });

  it('rejects missing/blank fields with a 400 ValidationError (Req 5.4)', async () => {
    const { prisma } = fakePrisma();
    const service = new UserManagementService(prisma);

    const bad: Array<{ username?: string; email?: string; password?: string }> = [
      { email: 'a@b.co', password: 'password123' }, // missing username
      { username: 'u', password: 'password123' }, // missing email
      { username: 'u', email: 'a@b.co' }, // missing password
      { username: '   ', email: 'a@b.co', password: 'password123' }, // blank username
      { username: 'u', email: '  ', password: 'password123' }, // blank email
      { username: 'u', email: 'a@b.co', password: '   ' }, // blank password
    ];

    for (const input of bad) {
      const err = await service.createSalesUser(input).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(400);
    }
  });
});

describe('UserManagementService.lock / unlock (Req 5.5, 5.6)', () => {
  it('lock sets locked = true (Req 5.5)', async () => {
    const { prisma, users } = fakePrisma([makeUser({ id: 'u-1', username: 'sales', locked: false })]);
    const service = new UserManagementService(prisma);

    const view = await service.lock('u-1');

    expect(view.locked).toBe(true);
    expect(users.get('u-1')!.locked).toBe(true);
  });

  it('unlock sets locked = false AND failedLoginCount = 0 (Req 5.6)', async () => {
    const { prisma, users } = fakePrisma([
      makeUser({ id: 'u-1', username: 'sales', locked: true, failedLoginCount: 5, lockedAt: new Date() }),
    ]);
    const service = new UserManagementService(prisma);

    const view = await service.unlock('u-1');

    expect(view.locked).toBe(false);
    const stored = users.get('u-1')!;
    expect(stored.locked).toBe(false);
    expect(stored.failedLoginCount).toBe(0);
  });
});

describe('UserManagementService.changeRole (Req 5.7)', () => {
  it('changes the role to ADMIN or SALES', async () => {
    const { prisma, users } = fakePrisma([makeUser({ id: 'u-1', username: 'sales', role: 'SALES' })]);
    const service = new UserManagementService(prisma);

    const toAdmin = await service.changeRole('u-1', 'ADMIN');
    expect(toAdmin.role).toBe('ADMIN');
    expect(users.get('u-1')!.role).toBe('ADMIN');

    const backToSales = await service.changeRole('u-1', 'SALES');
    expect(backToSales.role).toBe('SALES');
    expect(users.get('u-1')!.role).toBe('SALES');
  });

  it('rejects an invalid role with a 400 ValidationError', async () => {
    const { prisma } = fakePrisma([makeUser({ id: 'u-1', username: 'sales', role: 'SALES' })]);
    const service = new UserManagementService(prisma);

    const err = await service.changeRole('u-1', 'SUPERADMIN' as unknown as 'ADMIN').catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).status).toBe(400);
  });
});

describe('UserManagementService.resetPassword (Req 5.8)', () => {
  it(
    'stores an argon2 hash that verifyPassword accepts and is NOT the plaintext',
    async () => {
      const { prisma, users } = fakePrisma([
        makeUser({ id: 'u-1', username: 'sales', passwordHash: 'old:hash' }),
      ]);
      const service = new UserManagementService(prisma);

      const newPassword = 'brand-new-secret-1';
      await service.resetPassword('u-1', newPassword);

      const stored = users.get('u-1')!.passwordHash;
      // Not stored as plaintext, and not the old hash.
      expect(stored).not.toBe(newPassword);
      expect(stored).not.toBe('old:hash');
      // The persisted hash verifies the new password, and rejects a wrong one.
      expect(await verifyPassword(stored, newPassword)).toBe(true);
      expect(await verifyPassword(stored, 'wrong-password')).toBe(false);
    },
    15000,
  );

  it('rejects a blank new password with a 400 ValidationError', async () => {
    const { prisma } = fakePrisma([makeUser({ id: 'u-1', username: 'sales' })]);
    const service = new UserManagementService(prisma);

    const err = await service.resetPassword('u-1', '   ').catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).status).toBe(400);
  });
});

describe('AuthService login on a locked account (Req 5.10)', () => {
  it('throws LockedError (423) when the account is locked', async () => {
    const { prisma } = fakePrisma([
      makeUser({ id: 'u-1', username: 'lockedsales', locked: true, passwordHash: 'irrelevant' }),
    ]);
    const jwt = new JwtService('test-secret-key-please-ignore', 24, 30);
    const auth = new AuthService(prisma, jwt, 5);

    const err = await auth.login('lockedsales', 'whatever').catch((e) => e);

    expect(err).toBeInstanceOf(LockedError);
    expect((err as LockedError).status).toBe(423);
  });
});
