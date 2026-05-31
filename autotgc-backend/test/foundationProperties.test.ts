import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { hashPassword, verifyPassword } from '../src/auth/password';
import { JwtService } from '../src/auth/jwt';
import type { Clock, Role } from '../src/auth/jwt';
import {
  createSecretLoader,
  firstMissingSecret,
  MissingSecretError,
} from '../src/infra/secrets';
import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  LockedError,
  ALLOWED_STATUS_CODES,
  toErrorBody,
} from '../src/infra/errors';
import type { AllowedStatus } from '../src/infra/errors';
import {
  TokenManager,
  platformSecretName,
} from '../src/tokens/tokenManager';
import type { TokenType, TokenRefresher } from '../src/tokens/tokenManager';
import { InMemoryAlertDispatcher } from '../src/infra/alerts';
import { AuthService } from '../src/auth/authService';
import { ServiceAccountService } from '../src/auth/serviceAccountService';
import type { Action, Module } from '../src/auth/rbac';
import { requireAuth } from '../src/http/authMiddleware';
import type { AuthDeps } from '../src/http/authMiddleware';
import type { PlatformId } from '../src/platforms/adapter';

// ===========================================================================
// Shared test doubles / helpers
// ===========================================================================

const ALL_PLATFORMS: PlatformId[] = ['facebook', 'tiktok', 'custom_cms', 'ga4'];
const ALL_MODULES: Module[] = [
  'strategy', 'generation', 'publishing', 'analytics',
  'feedback', 'lead_management', 'settings', 'dashboard',
];
const ALL_ACTIONS: Action[] = ['read', 'create', 'update', 'delete', 'status_update'];

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

/**
 * Minimal shape of a Fastify request that requireAuth touches (headers + the
 * `auth` property it attaches). The preHandler only reads request.headers and
 * sets request.auth, so this structural type is sufficient for unit testing.
 */
interface FastifyRequestLike {
  headers: Record<string, string | undefined>;
  auth?: unknown;
}

/**
 * Invoke a preHandler that only reads `request` (requireAuth ignores reply/done).
 * We pass placeholder reply/done values to satisfy the Fastify handler arity.
 */
async function runPreHandler(
  handler: ReturnType<typeof requireAuth>,
  request: FastifyRequestLike,
): Promise<void> {
  const fn = handler as unknown as (req: FastifyRequestLike, reply: unknown, done: unknown) => Promise<void> | void;
  await fn(request, {}, () => undefined);
}

/** Decode a JWT payload segment without verifying the signature (for inspecting iat/exp). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const seg = token.split('.')[1] ?? '';
  const json = Buffer.from(seg, 'base64url').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

// ---- in-memory user/session Prisma fake (Auth_Service: Properties 4, 5, 6, 7) ----

interface FakeUser {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: Role;
  failedLoginCount: number;
  locked: boolean;
  lockedAt: Date | null;
}

interface FakeSession {
  sessionId: string;
  userId: string;
  status: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  revokedAt: Date | null;
}

interface AuthPrismaFake {
  prisma: PrismaClient;
  users: Map<string, FakeUser>;
  sessions: Map<string, FakeSession>;
  addUser: (u: Partial<FakeUser> & { username: string; passwordHash: string }) => FakeUser;
  addSession: (s: Partial<FakeSession> & { sessionId: string; userId: string }) => FakeSession;
}

function makeAuthPrisma(): AuthPrismaFake {
  const users = new Map<string, FakeUser>();
  const sessions = new Map<string, FakeSession>();

  const findUserByUsername = (username: string): FakeUser | null => {
    for (const u of users.values()) if (u.username === username) return u;
    return null;
  };

  const prisma = {
    userAccount: {
      findUnique: async (args: { where: { username?: string; id?: string } }): Promise<FakeUser | null> => {
        if (args.where.username !== undefined) return findUserByUsername(args.where.username);
        if (args.where.id !== undefined) return users.get(args.where.id) ?? null;
        return null;
      },
      create: async (args: { data: Omit<FakeUser, 'id' | 'failedLoginCount' | 'locked' | 'lockedAt'> & Partial<FakeUser> }): Promise<FakeUser> => {
        const id = args.data.id ?? randomUUID();
        const user: FakeUser = {
          id,
          username: args.data.username,
          email: args.data.email ?? '',
          passwordHash: args.data.passwordHash,
          role: (args.data.role ?? 'ADMIN') as Role,
          failedLoginCount: args.data.failedLoginCount ?? 0,
          locked: args.data.locked ?? false,
          lockedAt: args.data.lockedAt ?? null,
        };
        users.set(id, user);
        return user;
      },
      update: async (args: { where: { id: string }; data: Partial<FakeUser> }): Promise<FakeUser> => {
        const existing = users.get(args.where.id);
        if (!existing) throw new Error('user not found');
        const updated: FakeUser = { ...existing, ...args.data };
        users.set(existing.id, updated);
        return updated;
      },
    },
    jwtSession: {
      create: async (args: { data: Partial<FakeSession> & { userId: string; accessExpiresAt: Date; refreshExpiresAt: Date } }): Promise<FakeSession> => {
        const sessionId = args.data.sessionId ?? randomUUID();
        const session: FakeSession = {
          sessionId,
          userId: args.data.userId,
          status: args.data.status ?? 'ACTIVE',
          accessExpiresAt: args.data.accessExpiresAt,
          refreshExpiresAt: args.data.refreshExpiresAt,
          revokedAt: args.data.revokedAt ?? null,
        };
        sessions.set(sessionId, session);
        return session;
      },
      findUnique: async (args: { where: { sessionId: string } }): Promise<FakeSession | null> => {
        return sessions.get(args.where.sessionId) ?? null;
      },
      updateMany: async (args: { where: { sessionId: string; status?: string }; data: Partial<FakeSession> }): Promise<{ count: number }> => {
        const s = sessions.get(args.where.sessionId);
        if (!s) return { count: 0 };
        if (args.where.status !== undefined && s.status !== args.where.status) return { count: 0 };
        sessions.set(s.sessionId, { ...s, ...args.data });
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    users,
    sessions,
    addUser: (u) => {
      const id = u.id ?? randomUUID();
      const user: FakeUser = {
        id,
        username: u.username,
        email: u.email ?? 'x@y.co',
        passwordHash: u.passwordHash,
        role: (u.role ?? 'ADMIN') as Role,
        failedLoginCount: u.failedLoginCount ?? 0,
        locked: u.locked ?? false,
        lockedAt: u.lockedAt ?? null,
      };
      users.set(id, user);
      return user;
    },
    addSession: (s) => {
      const now = new Date();
      const session: FakeSession = {
        sessionId: s.sessionId,
        userId: s.userId,
        status: s.status ?? 'ACTIVE',
        accessExpiresAt: s.accessExpiresAt ?? new Date(now.getTime() + 3600_000),
        refreshExpiresAt: s.refreshExpiresAt ?? new Date(now.getTime() + 86_400_000),
        revokedAt: s.revokedAt ?? null,
      };
      sessions.set(session.sessionId, session);
      return session;
    },
  };
}

// ---- in-memory platform-token Prisma fake (Token_Manager: Properties 11, 14, 15) ----

interface FakeTokenRow {
  platform: string;
  type: string;
  expiresAt: Date | null;
  refreshWindowSeconds: number;
  status: string;
  lastRefreshFailureReason: string | null;
}

interface TokenPrismaFake {
  prisma: PrismaClient;
  rows: Map<string, FakeTokenRow>;
}

function makeTokenPrisma(initial: FakeTokenRow[] = []): TokenPrismaFake {
  const rows = new Map<string, FakeTokenRow>();
  for (const r of initial) rows.set(r.platform, { ...r });

  const prisma = {
    platformToken: {
      upsert: async (args: {
        where: { platform: string };
        create: Partial<FakeTokenRow> & { platform: string };
        update: Partial<FakeTokenRow>;
      }): Promise<FakeTokenRow> => {
        const existing = rows.get(args.where.platform);
        if (existing) {
          const updated: FakeTokenRow = { ...existing, ...args.update };
          rows.set(existing.platform, updated);
          return updated;
        }
        const created: FakeTokenRow = {
          platform: args.create.platform,
          type: args.create.type ?? 'access_token',
          expiresAt: args.create.expiresAt ?? null,
          refreshWindowSeconds: args.create.refreshWindowSeconds ?? 86_400,
          status: args.create.status ?? 'VALID',
          lastRefreshFailureReason: args.create.lastRefreshFailureReason ?? null,
        };
        rows.set(created.platform, created);
        return created;
      },
      findMany: async (args?: { orderBy?: { platform?: 'asc' | 'desc' } }): Promise<FakeTokenRow[]> => {
        const all = [...rows.values()].map((r) => ({ ...r }));
        if (args?.orderBy?.platform === 'asc') all.sort((a, b) => a.platform.localeCompare(b.platform));
        return all;
      },
      findUnique: async (args: { where: { platform: string } }): Promise<FakeTokenRow | null> => {
        const r = rows.get(args.where.platform);
        return r ? { ...r } : null;
      },
    },
  } as unknown as PrismaClient;

  return { prisma, rows };
}

/** Controllable refresher: succeeds or throws a configured error. */
function makeRefresher(behavior: { fail: boolean; message?: string }): TokenRefresher {
  return {
    exchange: async (): Promise<void> => {
      if (behavior.fail) throw new Error(behavior.message ?? 'refresh failed');
    },
  };
}

// ---- in-memory service-account Prisma fake (Property 9) ----

interface FakeServicePermission { module: string; action: string }
interface FakeServiceAccount {
  id: string;
  name: string;
  active: boolean;
  permissions: FakeServicePermission[];
}

function makeServiceAccountPrisma(account: FakeServiceAccount): PrismaClient {
  return {
    serviceAccount: {
      findFirst: async (args: {
        where: {
          name?: string;
          active?: boolean;
          permissions?: { some?: { module: string; action: string } };
        };
      }): Promise<{ id: string } | null> => {
        const w = args.where;
        if (w.name !== undefined && account.name !== w.name) return null;
        if (w.active !== undefined && account.active !== w.active) return null;
        const some = w.permissions?.some;
        if (some) {
          const matched = account.permissions.some(
            (p) => p.module === some.module && p.action === some.action,
          );
          if (!matched) return null;
        }
        return { id: account.id };
      },
    },
  } as unknown as PrismaClient;
}

// ===========================================================================
// Property 17 — Fail-fast on missing required secret (pure)
// ===========================================================================

describe('foundation-and-deployment secrets', () => {
  const SECRET_NAME_POOL = [
    'DATABASE_URL', 'JWT_SECRET', 'REDIS_URL', 'SERVER_HOST',
    'PLATFORM_TOKEN_FACEBOOK', 'WEBHOOK_SECRET', 'GA4_API_KEY',
  ];

  // Feature: foundation-and-deployment, Property 17: Fail-fast on missing required secret
  it('Property 17: firstMissingSecret returns the first absent name; require() names only the secret', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({ name: fc.constantFrom(...SECRET_NAME_POOL), present: fc.boolean() }),
          { selector: (x) => x.name, minLength: 1, maxLength: SECRET_NAME_POOL.length },
        ),
        (items) => {
          const source: Record<string, string> = {};
          for (const it of items) {
            if (it.present) source[it.name] = `value-of-${it.name}`;
          }
          const loader = createSecretLoader(source, [/.*/]); // treat every key as secret-tracked
          const requiredNames = items.map((i) => i.name);

          const firstMissing = items.find((i) => !i.present)?.name ?? null;
          expect(firstMissingSecret(loader, requiredNames)).toBe(firstMissing);

          // Each missing secret: require throws MissingSecretError naming ONLY the secret,
          // optional returns undefined.
          for (const it of items) {
            if (it.present) {
              expect(loader.require(it.name)).toBe(source[it.name]);
            } else {
              let thrown: unknown;
              try {
                loader.require(it.name);
              } catch (err) {
                thrown = err;
              }
              expect(thrown).toBeInstanceOf(MissingSecretError);
              const e = thrown as MissingSecretError;
              expect(e.secretName).toBe(it.name);
              expect(e.message).toContain(it.name);
              // The failure message must not leak any present secret VALUE.
              for (const present of items.filter((p) => p.present)) {
                expect(e.message.includes(source[present.name])).toBe(false);
              }
              expect(loader.optional(it.name)).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 19 — Responses use only the allowed status codes (pure)
// ===========================================================================

describe('foundation-and-deployment error model', () => {
  const errorFactories: Array<{ make: () => AppError; status: AllowedStatus }> = [
    { make: () => new ValidationError('bad input'), status: 400 },
    { make: () => new UnauthorizedError(), status: 401 },
    { make: () => new ForbiddenError(), status: 403 },
    { make: () => new NotFoundError(), status: 404 },
    { make: () => new ConflictError(), status: 409 },
    { make: () => new LockedError(), status: 423 },
  ];

  // Feature: foundation-and-deployment, Property 19: Responses use only the allowed status codes
  it('Property 19: every AppError subclass carries an allowed status and toErrorBody preserves it', () => {
    const identity = (s: string): string => s;
    for (const f of errorFactories) {
      const err = f.make();
      expect(err.status).toBe(f.status);
      expect(ALLOWED_STATUS_CODES.has(err.status)).toBe(true);
      const { status, body } = toErrorBody(err, identity);
      expect(ALLOWED_STATUS_CODES.has(status)).toBe(true);
      expect(status).toBe(f.status);
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      // Body must be JSON-serializable.
      expect(() => JSON.stringify(body)).not.toThrow();
    }
  });

  // Feature: foundation-and-deployment, Property 19: Responses use only the allowed status codes
  it('Property 19: toErrorBody yields an allowed status for any AppError and 500 for any non-AppError', () => {
    const identity = (s: string): string => s;
    const allowed = [...ALLOWED_STATUS_CODES] as AllowedStatus[];
    fc.assert(
      fc.property(
        fc.constantFrom(...allowed),
        fc.string(),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.oneof(
          fc.string().map((m) => new Error(m)),
          fc.string(),
          fc.integer(),
          fc.constant(null),
          fc.constant(undefined),
        ),
        (status, message, code, nonAppError) => {
          const appErr = new AppError(status, message, code);
          const a = toErrorBody(appErr, identity);
          expect(a.status).toBe(status);
          expect(ALLOWED_STATUS_CODES.has(a.status)).toBe(true);
          expect(a.body.error.code).toBe(code);

          const b = toErrorBody(nonAppError, identity);
          expect(b.status).toBe(500);
          expect(ALLOWED_STATUS_CODES.has(b.status)).toBe(true);
          expect(b.body.error.code).toBe('INTERNAL_ERROR');
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// Property 2 — Passwords are stored only as verifiable salted hashes (argon2id)
// argon2 is real + async; keep numRuns modest.
// ===========================================================================

describe('foundation-and-deployment password hashing', () => {
  // Feature: foundation-and-deployment, Property 2: Passwords are stored only as verifiable salted hashes
  it('Property 2: hash != plaintext, verifies the original, rejects a different password, and salts differ', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 64 }),
        fc.string({ minLength: 8, maxLength: 64 }),
        async (password, other) => {
          fc.pre(password !== other);
          const hash = await hashPassword(password);

          // Stored credential is never the plaintext.
          expect(hash).not.toBe(password);
          expect(hash.includes(password)).toBe(false);

          // The original password verifies; a different one does not.
          expect(await verifyPassword(hash, password)).toBe(true);
          expect(await verifyPassword(hash, other)).toBe(false);

          // Salting: two hashes of the same input differ but both verify.
          const hash2 = await hashPassword(password);
          expect(hash2).not.toBe(hash);
          expect(await verifyPassword(hash2, password)).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ===========================================================================
// Property 3 — Token issuance produces correct lifetimes and claims
// ===========================================================================

describe('foundation-and-deployment token issuance', () => {
  const ACCESS_TTL_HOURS = 24;
  const REFRESH_TTL_DAYS = 30;
  const ACCESS_TTL_SECONDS = ACCESS_TTL_HOURS * 3600;
  const REFRESH_TTL_SECONDS = REFRESH_TTL_DAYS * 86_400;

  // Feature: foundation-and-deployment, Property 3: Token issuance produces correct lifetimes and claims
  it('Property 3: issuePair access exp-iat == 24h, refresh exp-iat == 30d, claims {sub, role, sid, typ} correct', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.constantFrom<Role>('ADMIN', 'SALES'),
        fc.uuid(),
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
        fc.string({ minLength: 16, maxLength: 64 }),
        async (userId, role, sessionId, now, secret) => {
          // Lifetimes + claims are inspected by decoding the payload, so they hold
          // for ANY issuance time (deterministic via the injected clock).
          const jwt = new JwtService(secret, ACCESS_TTL_HOURS, REFRESH_TTL_DAYS, fixedClock(now));
          const pair = await jwt.issuePair(userId, role, sessionId);

          const access = decodeJwtPayload(pair.accessToken);
          const refresh = decodeJwtPayload(pair.refreshToken);
          const expectedIat = Math.floor(now.getTime() / 1000);

          // Lifetimes.
          expect(access.iat).toBe(expectedIat);
          expect(access.exp).toBe(expectedIat + ACCESS_TTL_SECONDS);
          expect((access.exp as number) - (access.iat as number)).toBe(ACCESS_TTL_SECONDS);
          expect(refresh.exp).toBe(expectedIat + REFRESH_TTL_SECONDS);
          expect((refresh.exp as number) - (refresh.iat as number)).toBe(REFRESH_TTL_SECONDS);

          // Claims.
          expect(access.sub).toBe(userId);
          expect(access.role).toBe(role);
          expect(access.sid).toBe(sessionId);
          expect(access.typ).toBe('access');
          expect(refresh.typ).toBe('refresh');

          // Round-trip verification uses tokens issued at the real wall clock, since
          // jose verifies `exp` against the current time. Claims must match exactly,
          // and presenting a token to the wrong expected type must be rejected.
          const nowJwt = new JwtService(secret, ACCESS_TTL_HOURS, REFRESH_TTL_DAYS, fixedClock(new Date()));
          const livePair = await nowJwt.issuePair(userId, role, sessionId);
          const accessClaims = await nowJwt.verify(livePair.accessToken, 'access');
          expect(accessClaims).toEqual({ sub: userId, role, sid: sessionId, typ: 'access' });
          const refreshClaims = await nowJwt.verify(livePair.refreshToken, 'refresh');
          expect(refreshClaims.sid).toBe(sessionId);

          await expect(nowJwt.verify(livePair.accessToken, 'refresh')).rejects.toThrow();
          await expect(nowJwt.verify(livePair.refreshToken, 'access')).rejects.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: foundation-and-deployment, Property 3: Token issuance produces correct lifetimes and claims
  it('Property 3: a refreshed access token keeps the same {sub, role, sid} as the originating session', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.constantFrom<Role>('ADMIN', 'SALES'),
        fc.uuid(),
        fc.string({ minLength: 16, maxLength: 64 }),
        async (userId, role, sessionId, secret) => {
          // Issued at the real wall clock so the round-trip verify (jose exp check) passes.
          const jwt = new JwtService(secret, ACCESS_TTL_HOURS, REFRESH_TTL_DAYS, fixedClock(new Date()));
          const refreshed = await jwt.issueAccess(userId, role, sessionId);
          const claims = await jwt.verify(refreshed, 'access');
          expect(claims.sub).toBe(userId);
          expect(claims.role).toBe(role);
          expect(claims.sid).toBe(sessionId);
          const payload = decodeJwtPayload(refreshed);
          expect((payload.exp as number) - (payload.iat as number)).toBe(ACCESS_TTL_SECONDS);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Properties 4 & 5 — Failed-login counter / lockout state machine & locked rejection
// Exercises the real AuthService against an in-memory user/session store.
// argon2 verify runs only on the wrong/correct paths, so sequences are short.
// ===========================================================================

describe('foundation-and-deployment login lockout', () => {
  const PASSWORD = 'correct-horse-battery';
  const WRONG = 'wrong-password-zzz';
  const THRESHOLD = 5;
  let passwordHash = '';

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  function buildAuthService(fake: AuthPrismaFake): AuthService {
    const jwt = new JwtService('test-signing-secret-0123456789', 24, 30, fixedClock(new Date()));
    return new AuthService(fake.prisma, jwt, THRESHOLD, 24, 30);
  }

  type Attempt = 'correct' | 'wrong' | 'unknown';

  // Feature: foundation-and-deployment, Property 4: Failed-login counter and lockout state machine
  it('Property 4: counter +1 on wrong, unchanged on unknown user, resets on success, locks at threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Attempt>('correct', 'wrong', 'unknown'), { minLength: 1, maxLength: 7 }),
        async (attempts) => {
          const fake = makeAuthPrisma();
          const user = fake.addUser({ username: 'alice', passwordHash, role: 'ADMIN' });
          const auth = buildAuthService(fake);

          // Reference model.
          let count = 0;
          let locked = false;

          for (const a of attempts) {
            let threw: unknown;
            try {
              if (a === 'unknown') await auth.login('does-not-exist', WRONG);
              else if (a === 'wrong') await auth.login('alice', WRONG);
              else await auth.login('alice', PASSWORD);
            } catch (err) {
              threw = err;
            }

            if (locked) {
              // Property 5 overlap: locked rejects everything with 423; state frozen.
              expect(threw).toBeInstanceOf(LockedError);
              expect((threw as AppError).status).toBe(423);
            } else if (a === 'unknown') {
              expect(threw).toBeInstanceOf(UnauthorizedError);
              // counter unchanged
            } else if (a === 'wrong') {
              count += 1;
              if (count >= THRESHOLD) locked = true;
              expect(threw).toBeInstanceOf(UnauthorizedError);
            } else {
              // correct password on an unlocked account: success, counter resets.
              expect(threw).toBeUndefined();
              count = 0;
            }

            const stored = fake.users.get(user.id);
            expect(stored?.failedLoginCount).toBe(count);
            expect(stored?.locked).toBe(locked);
            if (locked) expect(stored?.lockedAt).not.toBeNull();
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  // Feature: foundation-and-deployment, Property 5: Locked accounts reject all logins
  it('Property 5: a locked account rejects every login with 423, including with the correct password', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // present correct password or a wrong one
        async (useCorrect) => {
          const fake = makeAuthPrisma();
          fake.addUser({
            username: 'bob',
            passwordHash,
            role: 'ADMIN',
            locked: true,
            lockedAt: new Date(),
            failedLoginCount: THRESHOLD,
          });
          const auth = buildAuthService(fake);

          let threw: unknown;
          try {
            await auth.login('bob', useCorrect ? PASSWORD : WRONG);
          } catch (err) {
            threw = err;
          }
          expect(threw).toBeInstanceOf(LockedError);
          expect((threw as AppError).status).toBe(423);
          // No session was ever created for a locked account.
          expect(fake.sessions.size).toBe(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});

// ===========================================================================
// Properties 6 & 7 — Revoked sessions reject both tokens; auth enforcement
// ===========================================================================

describe('foundation-and-deployment session revocation and auth enforcement', () => {
  const PASSWORD = 'a-strong-password-1';
  let passwordHash = '';
  const SIGNING = 'enforcement-signing-secret-abc';

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  // Feature: foundation-and-deployment, Property 6: Revoked sessions reject both tokens
  it('Property 6: after logout, the access token fails auth (401) and the refresh token fails refresh (401)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Role>('ADMIN', 'SALES'), async (role) => {
        const fake = makeAuthPrisma();
        fake.addUser({ username: 'carol', passwordHash, role });
        const jwt = new JwtService(SIGNING, 24, 30, fixedClock(new Date()));
        const auth = new AuthService(fake.prisma, jwt, 5, 24, 30);

        const { tokens } = await auth.login('carol', PASSWORD);

        // Both tokens work before revocation.
        await expect(auth.refresh(tokens.refreshToken)).resolves.toBeDefined();
        const deps: AuthDeps = { prisma: fake.prisma, jwt };
        await expect(
          runPreHandler(requireAuth(deps), { headers: { authorization: `Bearer ${tokens.accessToken}` } }),
        ).resolves.toBeUndefined();

        // Revoke via logout.
        await auth.logout(tokens.accessToken);

        // Refresh token now rejected.
        await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);

        // Access token now rejected by the auth middleware.
        let threw: unknown;
        try {
          await runPreHandler(requireAuth(deps), { headers: { authorization: `Bearer ${tokens.accessToken}` } });
        } catch (err) {
          threw = err;
        }
        expect(threw).toBeInstanceOf(UnauthorizedError);
        expect((threw as AppError).status).toBe(401);
      }),
      { numRuns: 40 },
    );
  });

  // Feature: foundation-and-deployment, Property 7: Authentication enforcement on endpoints
  it('Property 7: protected requests with missing/malformed/expired/revoked tokens are rejected 401; valid+active attaches auth', async () => {
    type Case = 'missing' | 'malformed' | 'expired' | 'revoked' | 'valid';
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Case>('missing', 'malformed', 'expired', 'revoked', 'valid'),
        fc.constantFrom<Role>('ADMIN', 'SALES'),
        async (kind, role) => {
          const fake = makeAuthPrisma();
          const userId = randomUUID();
          fake.addUser({ id: userId, username: 'dave', passwordHash, role });
          const now = new Date('2030-01-01T00:00:00Z');
          const jwt = new JwtService(SIGNING, 24, 30, fixedClock(now));
          const deps: AuthDeps = { prisma: fake.prisma, jwt };

          let authorization: string | undefined;
          let expectReject = true;

          if (kind === 'missing') {
            authorization = undefined;
          } else if (kind === 'malformed') {
            authorization = 'Bearer not-a-jwt';
          } else if (kind === 'expired') {
            // Issue with a clock far in the past so the 24h access token is expired now.
            const pastJwt = new JwtService(SIGNING, 24, 30, fixedClock(new Date(Date.now() - 100 * 86_400_000)));
            const sid = randomUUID();
            fake.addSession({ sessionId: sid, userId, status: 'ACTIVE' });
            authorization = `Bearer ${await pastJwt.issueAccess(userId, role, sid)}`;
          } else if (kind === 'revoked') {
            const sid = randomUUID();
            fake.addSession({ sessionId: sid, userId, status: 'REVOKED', revokedAt: new Date() });
            authorization = `Bearer ${await jwt.issueAccess(userId, role, sid)}`;
          } else {
            const sid = randomUUID();
            fake.addSession({ sessionId: sid, userId, status: 'ACTIVE' });
            authorization = `Bearer ${await jwt.issueAccess(userId, role, sid)}`;
            expectReject = false;
          }

          const request = { headers: authorization ? { authorization } : {} } as FastifyRequestLike;

          if (expectReject) {
            let threw: unknown;
            try {
              await runPreHandler(requireAuth(deps), request);
            } catch (err) {
              threw = err;
            }
            expect(threw).toBeInstanceOf(UnauthorizedError);
            expect((threw as AppError).status).toBe(401);
            // The request was not augmented with an authenticated principal.
            expect((request as { auth?: unknown }).auth).toBeUndefined();
          } else {
            await runPreHandler(requireAuth(deps), request);
            const attached = (request as { auth?: { userId: string; role: Role } }).auth;
            expect(attached?.userId).toBe(userId);
            expect(attached?.role).toBe(role);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 9 — Service-account permission enforcement (closed allow-list)
// ===========================================================================

describe('foundation-and-deployment service accounts', () => {
  // Feature: foundation-and-deployment, Property 9: Service-account permission enforcement
  it('Property 9: assertPermission resolves iff (module, action) is in the closed permission set, else 403', async () => {
    const permissionSets: FakeServicePermission[][] = [
      // ai-system
      [
        { module: 'generation', action: 'create' },
        { module: 'strategy', action: 'read' },
      ],
      // background-worker
      [
        { module: 'analytics', action: 'read' },
        { module: 'analytics', action: 'create' },
        { module: 'feedback', action: 'create' },
        { module: 'publishing', action: 'status_update' },
      ],
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 1),
        fc.constantFrom(...ALL_MODULES),
        fc.constantFrom(...ALL_ACTIONS),
        async (idx, module, action) => {
          const perms = permissionSets[idx];
          const account: FakeServiceAccount = {
            id: randomUUID(),
            name: idx === 0 ? 'ai-system' : 'background-worker',
            active: true,
            permissions: perms,
          };
          const prisma = makeServiceAccountPrisma(account);
          const svc = new ServiceAccountService(prisma);

          const inSet = perms.some((p) => p.module === module && p.action === action);
          expect(await svc.hasPermission(account.name, module, action)).toBe(inSet);

          if (inSet) {
            await expect(svc.assertPermission(account.name, module, action)).resolves.toBeUndefined();
          } else {
            let threw: unknown;
            try {
              await svc.assertPermission(account.name, module, action);
            } catch (err) {
              threw = err;
            }
            expect(threw).toBeInstanceOf(ForbiddenError);
            expect((threw as AppError).status).toBe(403);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 9: Service-account permission enforcement
  it('Property 9: an inactive service account is denied every permission (403)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_MODULES),
        fc.constantFrom(...ALL_ACTIONS),
        async (module, action) => {
          const account: FakeServiceAccount = {
            id: randomUUID(),
            name: 'ai-system',
            active: false,
            permissions: [{ module, action }], // even a matching row must not grant when inactive
          };
          const svc = new ServiceAccountService(makeServiceAccountPrisma(account));
          expect(await svc.hasPermission(account.name, module, action)).toBe(false);
          await expect(svc.assertPermission(account.name, module, action)).rejects.toBeInstanceOf(ForbiddenError);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 11 — Platform token storage round-trip without secret leakage
// ===========================================================================

describe('foundation-and-deployment platform token storage', () => {
  const TOKEN_TYPES: TokenType[] = ['access_token', 'refresh_token', 'api_key', 'service_account'];

  function buildManager(
    secretSource: Record<string, string | undefined>,
    tokenFake: TokenPrismaFake,
    now: Date,
  ): { manager: TokenManager } {
    const loader = createSecretLoader(secretSource, [/PLATFORM_TOKEN/i, /TOKEN/i, /SECRET/i]);
    const manager = new TokenManager(
      tokenFake.prisma,
      loader,
      makeRefresher({ fail: false }),
      new InMemoryAlertDispatcher(),
      fixedClock(now),
    );
    return { manager };
  }

  // Feature: foundation-and-deployment, Property 11: Platform token storage round-trip without secret leakage
  it('Property 11: metadata round-trips and neither the stored row nor the public view contains the secret value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_PLATFORMS),
        fc.constantFrom(...TOKEN_TYPES),
        fc.string({ minLength: 12, maxLength: 40 }).map((s) => `sk-${s}-secret`),
        fc.option(fc.integer({ min: -10_000_000, max: 10_000_000 }), { nil: null }),
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
        async (platform, type, secretValue, offsetMs, now) => {
          // API-key and service-account credentials are recorded as non-expiring.
          const expiresAt =
            type === 'api_key' || type === 'service_account'
              ? null
              : offsetMs === null
                ? null
                : new Date(now.getTime() + offsetMs);

          const secretSource: Record<string, string | undefined> = {
            [platformSecretName(platform)]: secretValue,
          };
          const tokenFake = makeTokenPrisma();
          const { manager } = buildManager(secretSource, tokenFake, now);

          const view = await manager.register(platform, type, secretValue, expiresAt);

          // Round-trip metadata via register's returned view.
          expect(view.platform).toBe(platform);
          expect(view.type).toBe(type);
          expect(view.expiresAt?.getTime() ?? null).toBe(expiresAt?.getTime() ?? null);

          // Round-trip via the public list as well.
          const list = await manager.listPublic();
          const found = list.find((v) => v.platform === platform);
          expect(found).toBeDefined();
          expect(found?.type).toBe(type);
          expect(found?.expiresAt?.getTime() ?? null).toBe(expiresAt?.getTime() ?? null);

          // No secret value in the stored DB row.
          const storedRow = tokenFake.rows.get(platform);
          expect(JSON.stringify(storedRow).includes(secretValue)).toBe(false);

          // No secret value in any public view.
          expect(JSON.stringify(list).includes(secretValue)).toBe(false);
          expect(JSON.stringify(view).includes(secretValue)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 14 — Failed refresh retains the prior token and records the reason
// ===========================================================================

describe('foundation-and-deployment failed-refresh retention', () => {
  // Feature: foundation-and-deployment, Property 14: Failed refresh retains the prior token and records the reason
  it('Property 14: a failed refresh keeps the prior expiry/value and records a (redacted) failure reason', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_PLATFORMS),
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.string({ minLength: 4, maxLength: 30 }),
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
        async (platform, offsetMs, failMessage, now) => {
          const priorExpiry = new Date(now.getTime() + offsetMs);
          const tokenFake = makeTokenPrisma([
            {
              platform,
              type: 'access_token',
              expiresAt: priorExpiry,
              refreshWindowSeconds: 86_400,
              status: 'VALID',
              lastRefreshFailureReason: null,
            },
          ]);
          const secretSource: Record<string, string | undefined> = {
            [platformSecretName(platform)]: 'existing-token-value',
          };
          const loader = createSecretLoader(secretSource, [/PLATFORM_TOKEN/i]);
          const manager = new TokenManager(
            tokenFake.prisma,
            loader,
            makeRefresher({ fail: true, message: failMessage }),
            new InMemoryAlertDispatcher(),
            fixedClock(now),
          );

          const view = await manager.refresh(platform);

          const row = tokenFake.rows.get(platform);
          // Prior expiry retained unchanged.
          expect(row?.expiresAt?.getTime()).toBe(priorExpiry.getTime());
          expect(view.expiresAt?.getTime()).toBe(priorExpiry.getTime());
          // Failure recorded.
          expect(row?.status).toBe('REFRESH_FAILED');
          expect(row?.lastRefreshFailureReason).toBeTruthy();
          expect((row?.lastRefreshFailureReason ?? '').length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 15 — Token lifecycle alerting
// ===========================================================================

describe('foundation-and-deployment token lifecycle alerting', () => {
  type AlertKindName = 'EXPIRY' | 'PRE_EXPIRY_WARNING' | 'REFRESH_FAILURE';

  // Feature: foundation-and-deployment, Property 15: Token lifecycle alerting
  it('Property 15: refresh cycle raises EXPIRY/PRE_EXPIRY_WARNING per expiry state and REFRESH_FAILURE on failure, skipping non-expiring tokens', async () => {
    const REFRESH_WINDOW_SECONDS = 7 * 24 * 60 * 60; // 7 days

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            platform: fc.constantFrom(...ALL_PLATFORMS),
            // null => non-expiring; otherwise ms offset relative to `now`.
            offsetMs: fc.option(
              fc.integer({ min: -20 * 24 * 60 * 60 * 1000, max: 20 * 24 * 60 * 60 * 1000 }),
              { nil: null },
            ),
          }),
          { selector: (x) => x.platform, minLength: 1, maxLength: ALL_PLATFORMS.length },
        ),
        fc.boolean(), // refresher fails for the whole cycle
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
        async (configs, refresherFails, now) => {
          const windowMs = REFRESH_WINDOW_SECONDS * 1000;
          const rows: FakeTokenRow[] = configs.map((c) => ({
            platform: c.platform,
            type: 'access_token',
            expiresAt: c.offsetMs === null ? null : new Date(now.getTime() + c.offsetMs),
            refreshWindowSeconds: REFRESH_WINDOW_SECONDS,
            status: 'VALID',
            lastRefreshFailureReason: null,
          }));

          const secretSource: Record<string, string | undefined> = {};
          for (const c of configs) secretSource[platformSecretName(c.platform)] = 'tok-value';

          const tokenFake = makeTokenPrisma(rows);
          const loader = createSecretLoader(secretSource, [/PLATFORM_TOKEN/i]);
          const alerts = new InMemoryAlertDispatcher();
          const manager = new TokenManager(
            tokenFake.prisma,
            loader,
            makeRefresher({ fail: refresherFails, message: 'cycle failure' }),
            alerts,
            fixedClock(now),
          );

          await manager.runRefreshCycle(now);

          // Build the expected alert multiset from the model.
          const expected: Array<{ kind: AlertKindName; platform: string }> = [];
          for (const c of configs) {
            if (c.offsetMs === null) continue; // non-expiring => skipped (Req 11.7)
            const msUntilExpiry = c.offsetMs; // expiresAt - now
            const withinWindow = msUntilExpiry <= windowMs;
            if (!withinWindow) continue;
            if (msUntilExpiry <= 0) expected.push({ kind: 'EXPIRY', platform: c.platform });
            else expected.push({ kind: 'PRE_EXPIRY_WARNING', platform: c.platform });
            if (refresherFails) expected.push({ kind: 'REFRESH_FAILURE', platform: c.platform });
          }

          const actual = alerts.alerts.map((a) => ({ kind: a.kind, platform: a.platform }));

          const sortKey = (x: { kind: string; platform: string }): string => `${x.platform}:${x.kind}`;
          expect([...actual].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
            [...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
          );

          // Every REFRESH_FAILURE alert carries a (non-empty) reason and names its platform.
          for (const a of alerts.alerts) {
            expect(ALL_PLATFORMS.includes(a.platform as PlatformId)).toBe(true);
            if (a.kind === 'REFRESH_FAILURE') {
              expect(a.reason && a.reason.length > 0).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
