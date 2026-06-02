/**
 * Property-based tests for the foundation-and-deployment spec.
 *
 * Each test maps 1:1 to a Correctness Property from
 * `.kiro/specs/foundation-and-deployment/design.md` and is tagged
 *   // Feature: foundation-and-deployment, Property {n}: {exact property text}
 *
 * Conventions follow the existing suites (auth.test.ts, platforms.test.ts,
 * leadsAndInfra.test.ts): pure functions are tested directly; collaborators are
 * mocked via in-memory fakes; clocks are injected for determinism. argon2-backed
 * properties use a small numRuns because hashing is intentionally slow.
 *
 * Some property clauses require a live PostgreSQL/Redis or the full Fastify HTTP
 * stack and cannot be unit-tested against pure code; those are marked it.skip
 * with an explicit reason rather than faked.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decodeJwt } from 'jose';

import { validateRegistration } from '../src/auth/validation';
import { authorize } from '../src/auth/rbac';
import type { Action, Module } from '../src/auth/rbac';
import { JwtService } from '../src/auth/jwt';
import type { Clock, Role } from '../src/auth/jwt';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { AuthService } from '../src/auth/authService';
import { ServiceAccountService } from '../src/auth/serviceAccountService';

import { createSecretLoader, firstMissingSecret, MissingSecretError } from '../src/infra/secrets';
import { computeSignature, verifySignature } from '../src/infra/hmac';
import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  LockedError,
  toErrorBody,
  ALLOWED_STATUS_CODES,
} from '../src/infra/errors';
import { InMemoryAlertDispatcher } from '../src/infra/alerts';

import { AdapterRegistry, BasePlatformAdapter } from '../src/platforms/registry';
import { UnsupportedOperationError, UnsupportedPlatformError } from '../src/platforms/adapter';
import type {
  AnalyticsQuery,
  AnalyticsResult,
  Capability,
  PlatformAdapter,
  PlatformId,
  PublishRequest,
  PublishResult,
} from '../src/platforms/adapter';

import {
  TokenManager,
  computeRefreshedExpiry,
  isTokenValid,
  platformSecretName,
} from '../src/tokens/tokenManager';
import type { TokenType } from '../src/tokens/tokenManager';

import { requireAuth, PUBLIC_PATHS } from '../src/http/authMiddleware';

// ---------------------------------------------------------------------------
// Shared fixtures / helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = 'unit-test-signing-secret-key-which-is-long-enough-0123456789';

const MODULES: Module[] = [
  'strategy', 'generation', 'publishing', 'analytics',
  'feedback', 'lead_management', 'settings', 'dashboard',
];
const ACTIONS: Action[] = ['read', 'create', 'update', 'delete', 'status_update'];
const ALL_PLATFORMS: PlatformId[] = ['facebook', 'tiktok', 'custom_cms', 'ga4'];

const fixedClock = (d: Date): Clock => ({ now: () => d });

/** Adapter whose capability matrix is configurable (mirrors platforms.test.ts). */
class FakeAdapter extends BasePlatformAdapter {
  readonly platform: PlatformId;
  readonly capabilities: ReadonlySet<Capability>;
  constructor(platform: PlatformId, caps: Capability[]) {
    super();
    this.platform = platform;
    this.capabilities = new Set<Capability>(caps);
  }
  async publish(_req: PublishRequest): Promise<PublishResult> {
    this.assertSupported('publish');
    return { externalId: `${this.platform}-post`, raw: {} };
  }
  async collectAnalytics(_q: AnalyticsQuery): Promise<AnalyticsResult> {
    this.assertSupported('analytics');
    return { metrics: {}, raw: {} };
  }
}

/** In-memory fake of the Prisma surface the AuthService / requireAuth use. */
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
function makeAuthPrisma(users: FakeUser[]) {
  const byUsername = new Map<string, FakeUser>();
  const byId = new Map<string, FakeUser>();
  for (const u of users) {
    byUsername.set(u.username, u);
    byId.set(u.id, u);
  }
  const sessions = new Map<string, any>();
  let seq = 0;
  const prisma: any = {
    userAccount: {
      findUnique: async ({ where }: any) => {
        if (where.username !== undefined) return byUsername.get(where.username) ?? null;
        if (where.id !== undefined) return byId.get(where.id) ?? null;
        return null;
      },
      update: async ({ where: { id }, data }: any) => {
        const u = byId.get(id);
        if (!u) throw new Error('no such user');
        Object.assign(u, data);
        return u;
      },
      create: async ({ data }: any) => {
        const u = { id: 'u' + seq++, ...data };
        byId.set(u.id, u);
        byUsername.set(u.username, u);
        return u;
      },
    },
    jwtSession: {
      create: async ({ data }: any) => {
        const sessionId = 'sess-' + seq++;
        const row = { sessionId, ...data };
        sessions.set(sessionId, row);
        return row;
      },
      findUnique: async ({ where: { sessionId } }: any) => sessions.get(sessionId) ?? null,
      updateMany: async ({ where, data }: any) => {
        const row = sessions.get(where.sessionId);
        if (row && (where.status === undefined || row.status === where.status)) {
          Object.assign(row, data);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    __sessions: sessions,
  };
  return prisma;
}

/** In-memory fake of the Prisma surface the TokenManager uses. */
function makeTokenPrisma(rows: any[] = []) {
  const map = new Map<string, any>();
  for (const r of rows) {
    map.set(r.platform, { refreshWindowSeconds: 0, lastRefreshFailureReason: null, ...r });
  }
  const prisma: any = {
    platformToken: {
      upsert: async ({ where: { platform }, create, update }: any) => {
        if (map.has(platform)) {
          const row = map.get(platform);
          Object.assign(row, update);
          return { ...row };
        }
        const row = { refreshWindowSeconds: 0, lastRefreshFailureReason: null, ...create };
        map.set(platform, row);
        return { ...row };
      },
      findUnique: async ({ where: { platform } }: any) => {
        const r = map.get(platform);
        return r ? { ...r } : null;
      },
      findMany: async (args: any = {}) => {
        const arr = [...map.values()];
        if (args?.orderBy?.platform === 'asc') {
          arr.sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0));
        }
        return arr.map((r) => ({ ...r }));
      },
    },
    __map: map,
  };
  return prisma;
}

/** In-memory fake of the Prisma surface ServiceAccountService.hasPermission uses. */
function makeServicePrisma(account: any) {
  const prisma: any = {
    serviceAccount: {
      findUnique: async ({ where: { name } }: any) =>
        account && account.name === name ? { ...account } : null,
      findFirst: async ({ where }: any) => {
        if (!account) return null;
        if (where.name !== undefined && where.name !== account.name) return null;
        if (where.active === true && !account.active) return null;
        const some = where.permissions?.some;
        if (some) {
          const has = account.permissions.some(
            (p: any) => p.module === some.module && p.action === some.action,
          );
          if (!has) return null;
        }
        return { id: account.id };
      },
    },
  };
  return prisma;
}

// ===========================================================================
// Auth domain properties
// ===========================================================================

describe('foundation-and-deployment auth properties', () => {
  // Feature: foundation-and-deployment, Property 1: Registration input validation
  it('Property 1: registration accepts iff all rules hold, else rejects (400)', () => {
    fc.assert(
      fc.property(
        fc.record({
          username: fc.string(),
          email: fc.string(),
          password: fc.string(),
          passwordConfirmation: fc.string(),
        }),
        (input) => {
          const r = validateRegistration(input);
          const emailOk =
            input.email.length > 0 &&
            input.email.length <= 254 &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email);
          const pwOk = input.password.length >= 8 && input.password.length <= 128;
          const matchOk = input.password === input.passwordConfirmation;
          const userOk = input.username.trim().length > 0 && input.username.length <= 50;
          const expected = emailOk && pwOk && matchOk && userOk;
          expect(r.ok).toBe(expected);
          if (!r.ok) expect(r.status).toBe(400);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: foundation-and-deployment, Property 2: Passwords are stored only as verifiable salted hashes
  it('Property 2: stored credential != plaintext; verify true for correct, false for wrong', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 64 }),
        fc.string({ minLength: 8, maxLength: 64 }),
        async (password, other) => {
          const hash = await hashPassword(password);
          // Hash is never equal to the plaintext (salted argon2id encoding).
          expect(hash).not.toBe(password);
          expect(hash.includes(password)).toBe(false);
          // Correct password verifies; a different password does not.
          expect(await verifyPassword(hash, password)).toBe(true);
          if (other !== password) {
            expect(await verifyPassword(hash, other)).toBe(false);
          }
        },
      ),
      // argon2id hashing is intentionally slow; keep the case count small.
      { numRuns: 20 },
    );
    // argon2id is CPU/memory-hard; under the full suite's parallel workers the
    // default 5s timeout can be exceeded purely from contention. Give it room.
  }, 30_000);

  // Feature: foundation-and-deployment, Property 3: Token issuance produces correct lifetimes and claims
  it('Property 3: access exp-iat == 24h, refresh exp-iat == 30d, claims match; refresh keeps {sub,role,sid}', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.constantFrom<Role>('ADMIN', 'SALES'),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01') }),
        async (userId, role, sid, now) => {
          const jwt = new JwtService(JWT_SECRET, 24, 30, fixedClock(now));
          const pair = await jwt.issuePair(userId, role, sid);

          // Read claims via decodeJwt (no expiry validation): the injected clock
          // can sit far from wall-clock, which jwtVerify would reject on `exp`.
          const a = decodeJwt(pair.accessToken);
          const r = decodeJwt(pair.refreshToken);
          expect((a.exp as number) - (a.iat as number)).toBe(24 * 3600);
          expect((r.exp as number) - (r.iat as number)).toBe(30 * 86400);

          expect(a.sub).toBe(userId);
          expect(a.role).toBe(role);
          expect(a.sid).toBe(sid);
          expect(a.typ).toBe('access');
          expect(r.typ).toBe('refresh');

          // On refresh, the new Access_Token carries the same {sub, role, sid}.
          const refreshed = await jwt.issueAccess(userId, role, sid);
          const rc = decodeJwt(refreshed);
          expect(rc.sub).toBe(userId);
          expect(rc.role).toBe(role);
          expect(rc.sid).toBe(sid);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 4: Failed-login counter and lockout state machine
  it('Property 4: counter +1 on wrong (existing/unlocked), unchanged on unknown user, resets on success, locks at 5', async () => {
    const CORRECT = 'correct-horse-battery-staple';
    const hash = await hashPassword(CORRECT); // hash once; reuse across the property
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<'wrong' | 'correct' | 'unknown'>('wrong', 'correct', 'unknown'), {
          minLength: 1,
          maxLength: 6,
        }),
        async (actions) => {
          const user: FakeUser = {
            id: 'u1',
            username: 'realuser',
            email: 'a@b.co',
            passwordHash: hash,
            role: 'ADMIN',
            failedLoginCount: 0,
            locked: false,
            lockedAt: null,
          };
          const prisma = makeAuthPrisma([user]);
          const svc = new AuthService(prisma, new JwtService(JWT_SECRET, 24, 30), 5);

          let expCount = 0;
          let expLocked = false;
          for (const action of actions) {
            if (expLocked) {
              // Once locked, every attempt is rejected and state is unchanged.
              await expect(svc.login('realuser', CORRECT)).rejects.toBeInstanceOf(LockedError);
              expect(user.failedLoginCount).toBe(expCount);
              expect(user.locked).toBe(true);
              continue;
            }
            if (action === 'unknown') {
              await expect(svc.login('___unknown___', 'whatever')).rejects.toBeInstanceOf(
                UnauthorizedError,
              );
              expect(user.failedLoginCount).toBe(expCount); // unknown user never touches the counter
            } else if (action === 'wrong') {
              await expect(svc.login('realuser', 'definitely-wrong')).rejects.toBeInstanceOf(
                UnauthorizedError,
              );
              expCount += 1;
              if (expCount >= 5) expLocked = true;
              expect(user.failedLoginCount).toBe(expCount);
              expect(user.locked).toBe(expLocked);
              if (expLocked) expect(user.lockedAt).not.toBeNull();
            } else {
              await expect(svc.login('realuser', CORRECT)).resolves.toBeDefined();
              expCount = 0;
              expect(user.failedLoginCount).toBe(0);
              expect(user.locked).toBe(false);
            }
          }
        },
      ),
      // Each wrong/correct attempt runs an argon2id verify; keep numRuns modest.
      { numRuns: 25 },
    );
  });

  // Feature: foundation-and-deployment, Property 5: Locked accounts reject all logins
  it('Property 5: a locked account rejects every login with 423, even with the correct password', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (anyPassword) => {
        const user: FakeUser = {
          id: 'u1',
          username: 'lockeduser',
          email: 'a@b.co',
          passwordHash: 'irrelevant-never-verified',
          role: 'ADMIN',
          failedLoginCount: 4,
          locked: true,
          lockedAt: new Date(),
        };
        const prisma = makeAuthPrisma([user]);
        const svc = new AuthService(prisma, new JwtService(JWT_SECRET, 24, 30), 5);
        // Lock check precedes the password check, so any non-empty password -> 423.
        await expect(svc.login('lockeduser', anyPassword)).rejects.toBeInstanceOf(LockedError);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 6: Revoked sessions reject both tokens
  it('Property 6: after logout/revocation, the access token (requireAuth) and refresh token both 401', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.constantFrom<Role>('ADMIN', 'SALES'),
        async (userId, role) => {
          const sid = 'sess-fixed';
          const jwt = new JwtService(JWT_SECRET, 24, 30);
          const prisma = makeAuthPrisma([]);
          prisma.__sessions.set(sid, { sessionId: sid, userId, status: 'ACTIVE', revokedAt: null });
          const svc = new AuthService(prisma, jwt, 5);
          const pair = await jwt.issuePair(userId, role, sid);
          const handler: any = requireAuth({ prisma, jwt });

          // Before revocation both tokens work.
          await expect(svc.refresh(pair.refreshToken)).resolves.toHaveProperty('accessToken');
          const reqOk: any = { headers: { authorization: `Bearer ${pair.accessToken}` } };
          await handler(reqOk, {});
          expect(reqOk.auth?.sessionId).toBe(sid);

          // Logout revokes the session.
          await svc.logout(pair.accessToken);

          // After revocation the refresh token is rejected with 401...
          await expect(svc.refresh(pair.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
          // ...and the access token is rejected at the auth boundary with 401.
          const reqDenied: any = { headers: { authorization: `Bearer ${pair.accessToken}` } };
          let err: any;
          try {
            await handler(reqDenied, {});
          } catch (e) {
            err = e;
          }
          expect(err).toBeInstanceOf(UnauthorizedError);
          expect(err.status).toBe(401);
          expect(reqDenied.auth).toBeUndefined();
        },
      ),
      { numRuns: 60 },
    );
    // Note: the Redis revocation mirror (fast-path on every request, TTL = remaining
    // refresh lifetime) is exercised by the integration suite; the authoritative
    // session-status logic is covered here against an in-memory repository fake.
  });

  // Feature: foundation-and-deployment, Property 7: Authentication enforcement on endpoints
  it('Property 7: protected requests with missing/malformed/expired/revoked tokens are denied 401, request not processed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'missing' | 'wrongScheme' | 'emptyToken' | 'garbage' | 'expired' | 'revoked'>(
          'missing',
          'wrongScheme',
          'emptyToken',
          'garbage',
          'expired',
          'revoked',
        ),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (scenario, sid) => {
          const jwt = new JwtService(JWT_SECRET, 24, 30);
          const expiredJwt = new JwtService(JWT_SECRET, 24, 30, fixedClock(new Date('2000-01-01T00:00:00Z')));
          const prisma = makeAuthPrisma([]);

          let authz: string | undefined;
          if (scenario === 'missing') authz = undefined;
          else if (scenario === 'wrongScheme') authz = 'Basic dXNlcjpwYXNz';
          else if (scenario === 'emptyToken') authz = 'Bearer ';
          else if (scenario === 'garbage') authz = 'Bearer not-a-real-jwt';
          else if (scenario === 'expired') {
            const t = await expiredJwt.issueAccess('u1', 'ADMIN', sid);
            prisma.__sessions.set(sid, { sessionId: sid, status: 'ACTIVE', revokedAt: null });
            authz = `Bearer ${t}`;
          } else {
            const t = await jwt.issueAccess('u1', 'ADMIN', sid);
            prisma.__sessions.set(sid, { sessionId: sid, status: 'REVOKED', revokedAt: new Date() });
            authz = `Bearer ${t}`;
          }

          const handler: any = requireAuth({ prisma, jwt });
          const req: any = { headers: authz === undefined ? {} : { authorization: authz } };
          let err: any;
          try {
            await handler(req, {});
          } catch (e) {
            err = e;
          }
          expect(err).toBeInstanceOf(UnauthorizedError);
          expect(err.status).toBe(401);
          expect(req.auth).toBeUndefined(); // request principal never attached -> handler never runs
        },
      ),
      { numRuns: 150 },
    );
    // The "requires auth iff not in the public allow-list" clause is wired in app.ts
    // (global preHandler over PUBLIC_PATHS) and is validated by integration/smoke tests.
    expect(PUBLIC_PATHS).toEqual(expect.arrayContaining([
      '/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/healthz',
    ]));
  });

  // Feature: foundation-and-deployment, Property 7 (positive): a valid token on an active session authenticates
  it('Property 7 (positive): valid token + ACTIVE session attaches {userId, role, sessionId}', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.constantFrom<Role>('ADMIN', 'SALES'),
        async (sid, role) => {
          const jwt = new JwtService(JWT_SECRET, 24, 30);
          const prisma = makeAuthPrisma([]);
          prisma.__sessions.set(sid, { sessionId: sid, status: 'ACTIVE', revokedAt: null });
          const token = await jwt.issueAccess('user-1', role, sid);
          const handler: any = requireAuth({ prisma, jwt });
          const req: any = { headers: { authorization: `Bearer ${token}` } };
          await handler(req, {});
          expect(req.auth).toEqual({ userId: 'user-1', role, sessionId: sid });
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: foundation-and-deployment, Property 8: RBAC decisions match the role/module/action/ownership policy
  it('Property 8: authorize() grants exactly per the ADMIN/SALES policy table', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Role>('ADMIN', 'SALES'),
        fc.constantFrom(...MODULES),
        fc.constantFrom(...ACTIONS),
        fc.boolean(),
        (role, module, action, assignedToSelf) => {
          const ctx = { userId: 'u1', role };
          const ownerUserId =
            module === 'lead_management' ? (assignedToSelf ? 'u1' : 'u2') : undefined;
          const d = authorize(ctx, { module, action, ownerUserId });

          if (role === 'ADMIN') {
            expect(d.allowed).toBe(true);
            return;
          }
          // SALES
          if (module === 'lead_management') {
            if (action === 'delete' || action === 'create') expect(d.allowed).toBe(false);
            else if (!assignedToSelf) expect(d.allowed).toBe(false);
            else expect(d.allowed).toBe(true);
          } else if (module === 'dashboard') {
            expect(d.allowed).toBe(action === 'read');
          } else {
            expect(d.allowed).toBe(false);
          }
          if (!d.allowed) expect(d.status).toBe(403);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: foundation-and-deployment, Property 9: Service-account permission enforcement
  it('Property 9: a service account is granted an operation iff it lies within its closed permission set (else 403)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom(...MODULES), fc.constantFrom(...ACTIONS)), { maxLength: 8 }),
        fc.constantFrom(...MODULES),
        fc.constantFrom(...ACTIONS),
        async (perms, qModule, qAction) => {
          const account = {
            id: 'sa1',
            name: 'ai-system',
            active: true,
            credentialHash: 'x',
            permissions: perms.map(([m, a]) => ({ module: m, action: a })),
          };
          const svc = new ServiceAccountService(makeServicePrisma(account));
          const member = perms.some(([m, a]) => m === qModule && a === qAction);

          expect(await svc.hasPermission('ai-system', qModule, qAction)).toBe(member);
          if (member) {
            await expect(svc.assertPermission('ai-system', qModule, qAction)).resolves.toBeUndefined();
          } else {
            await expect(svc.assertPermission('ai-system', qModule, qAction)).rejects.toBeInstanceOf(
              ForbiddenError,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 9: Service-account permission enforcement
  it.skip('Property 9 (interactive-login clause): interactive login targeting a service account -> 403 — enforced at the route/HTTP layer, not as a pure function (AuthService.login looks up user_account only)', () => {
    // The "interactive login attempt targeting a service account is rejected with 403"
    // clause is wired at the route layer; there is no pure helper to property-test it.
  });
});

// ===========================================================================
// Platform integration & token management properties
// ===========================================================================

describe('foundation-and-deployment platform/token properties', () => {
  // Feature: foundation-and-deployment, Property 10: Adapter registry routing correctness
  it('Property 10: registration is additive; previously registered platforms keep resolving to their adapter', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ALL_PLATFORMS), { minLength: 1, maxLength: 4 }),
        (platforms) => {
          const registry = new AdapterRegistry();
          const seen: PlatformId[] = [];
          for (const p of platforms) {
            const adapter = new FakeAdapter(p, ['publish', 'analytics']);
            registry.register(adapter);
            seen.push(p);
            for (const prev of seen) {
              expect(registry.has(prev)).toBe(true);
              expect(registry.get(prev).platform).toBe(prev);
            }
          }
          expect(new Set(registry.list())).toEqual(new Set(platforms));
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 10: Adapter registry routing correctness
  it('Property 10: unknown platform -> UnsupportedPlatformError (400); unimplemented capability -> UnsupportedOperationError (400)', async () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ALL_PLATFORMS), { minLength: 0, maxLength: 4 }),
        (present) => {
          const registry = new AdapterRegistry();
          for (const p of present) registry.register(new FakeAdapter(p, ['analytics']));
          for (const p of ALL_PLATFORMS) {
            if (present.includes(p)) continue;
            expect(registry.has(p)).toBe(false);
            let thrown: unknown;
            try {
              registry.get(p);
            } catch (e) {
              thrown = e;
            }
            expect(thrown).toBeInstanceOf(UnsupportedPlatformError);
            expect((thrown as UnsupportedPlatformError).status).toBe(400);
            expect((thrown as UnsupportedPlatformError).message).toContain(p);
          }
        },
      ),
      { numRuns: 200 },
    );

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_PLATFORMS),
        fc.subarray<Capability>(['publish', 'analytics']),
        async (platform, caps) => {
          const adapter: PlatformAdapter = new FakeAdapter(platform, caps);
          for (const op of ['publish', 'analytics'] as Capability[]) {
            const call =
              op === 'publish'
                ? adapter.publish({ draftId: 'd', title: 't', body: 'b', ctas: [], idempotencyKey: 'k' })
                : adapter.collectAnalytics({});
            if (adapter.supports(op)) {
              await expect(call).resolves.toBeDefined();
            } else {
              await expect(call).rejects.toBeInstanceOf(UnsupportedOperationError);
              await expect(call).rejects.toHaveProperty('status', 400);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 11: Platform token storage round-trip without secret leakage
  it('Property 11: register/read-back preserves platform/type/expiry; neither the row nor the public view leaks the secret value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_PLATFORMS),
        fc.constantFrom<TokenType>('access_token', 'refresh_token', 'api_key', 'service_account'),
        fc.option(fc.integer({ min: -10_000_000, max: 10_000_000 }), { nil: null }),
        fc.hexaString({ minLength: 16, maxLength: 40 }).map((s) => `tok_${s}`),
        async (platform, type, offsetMs, secretValue) => {
          const now = new Date('2026-01-01T00:00:00Z');
          // API-key & service-account credentials are recorded as non-expiring.
          const expiresAt =
            type === 'api_key' || type === 'service_account'
              ? null
              : offsetMs === null
                ? null
                : new Date(now.getTime() + offsetMs);

          const prisma = makeTokenPrisma([]);
          const secrets = createSecretLoader({ [platformSecretName(platform)]: secretValue });
          const tm = new TokenManager(
            prisma,
            secrets,
            { exchange: async () => {} },
            new InMemoryAlertDispatcher(),
            fixedClock(now),
          );

          await tm.register(platform, type, secretValue, expiresAt);
          const view = (await tm.listPublic()).find((v) => v.platform === platform)!;

          expect(view.type).toBe(type);
          expect(view.expiresAt === null ? null : view.expiresAt.getTime()).toBe(
            expiresAt === null ? null : expiresAt.getTime(),
          );
          // No secret leakage in the public view or the stored metadata row.
          expect(JSON.stringify(view)).not.toContain(secretValue);
          expect(JSON.stringify(prisma.__map.get(platform))).not.toContain(secretValue);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: foundation-and-deployment, Property 12: Token validity predicate
  it('Property 12: valid iff value present AND (non-expiring OR expiry strictly in the future)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.integer({ min: -10_000_000, max: 10_000_000 }), { nil: null }),
        fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01') }),
        (hasValue, offsetMs, now) => {
          const expiresAt = offsetMs === null ? null : new Date(now.getTime() + offsetMs);
          const result = isTokenValid(hasValue, expiresAt, now);
          const expected =
            hasValue && (expiresAt === null || expiresAt.getTime() > now.getTime());
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: foundation-and-deployment, Property 13: Refresh cycle selection and expiry update
  it('Property 13: facebook refresh -> now + 60d, tiktok -> now + 24h (pure expiry update)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2100-01-01') }),
        fc.option(fc.integer({ min: -10_000_000, max: 10_000_000 }), { nil: null }),
        (now, currentOffset) => {
          const currentExpiry =
            currentOffset === null ? null : new Date(now.getTime() + currentOffset);
          expect(computeRefreshedExpiry('facebook', now, currentExpiry)?.getTime()).toBe(
            now.getTime() + 60 * 86_400_000,
          );
          expect(computeRefreshedExpiry('tiktok', now, currentExpiry)?.getTime()).toBe(
            now.getTime() + 24 * 60 * 60 * 1000,
          );
          // No known refresh rule -> retain the current expiry unchanged.
          expect(computeRefreshedExpiry('ga4', now, currentExpiry)).toBe(currentExpiry);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: foundation-and-deployment, Property 13: Refresh cycle selection and expiry update
  it('Property 13: runRefreshCycle selects exactly tokens within their refresh window and never a non-expiring token', async () => {
    const pool: PlatformId[] = ['facebook', 'tiktok', 'custom_cms', 'ga4'];
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            platform: fc.constantFrom(...pool),
            offsetMs: fc.option(fc.integer({ min: -5_000_000, max: 5_000_000 }), { nil: null }),
            windowSeconds: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 0, maxLength: 6 },
        ),
        async (specs) => {
          const now = new Date('2026-01-01T00:00:00Z');
          const rows = specs.map((s) => ({
            platform: s.platform,
            type: 'access_token',
            expiresAt: s.offsetMs === null ? null : new Date(now.getTime() + s.offsetMs),
            refreshWindowSeconds: s.windowSeconds,
            status: 'VALID',
          }));
          const prisma = makeTokenPrisma(rows); // de-dupes by platform (last wins)
          // Snapshot the selection criteria BEFORE the cycle mutates expiries.
          const initialRows = [...prisma.__map.values()].map((r) => ({
            platform: r.platform,
            expiresAt: r.expiresAt as Date | null,
            refreshWindowSeconds: r.refreshWindowSeconds as number,
          }));
          const exchanged: string[] = [];
          const tm = new TokenManager(
            prisma,
            createSecretLoader({}),
            { exchange: async (platform: string) => { exchanged.push(platform); } },
            new InMemoryAlertDispatcher(),
            fixedClock(now),
          );

          await tm.runRefreshCycle(now);

          const expected = initialRows
            .filter(
              (r) =>
                r.expiresAt !== null &&
                r.expiresAt.getTime() - now.getTime() <= r.refreshWindowSeconds * 1000,
            )
            .map((r) => r.platform);

          expect(new Set(exchanged)).toEqual(new Set(expected));
          for (const r of initialRows) {
            if (r.expiresAt === null) expect(exchanged).not.toContain(r.platform);
          }
          // Successful refresh updates the stored expiry per the platform rule.
          for (const p of expected) {
            if (p === 'facebook') {
              expect(prisma.__map.get('facebook').expiresAt.getTime()).toBe(
                now.getTime() + 60 * 86_400_000,
              );
            }
            if (p === 'tiktok') {
              expect(prisma.__map.get('tiktok').expiresAt.getTime()).toBe(
                now.getTime() + 24 * 60 * 60 * 1000,
              );
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: foundation-and-deployment, Property 14: Failed refresh retains the prior token and records the reason
  it('Property 14: a failed refresh leaves the prior expiry unchanged and records a failure reason', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_PLATFORMS),
        fc.option(fc.integer({ min: -10_000_000, max: 10_000_000 }), { nil: null }),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (platform, offsetMs, reason) => {
          const now = new Date('2026-01-01T00:00:00Z');
          const origExpiry = offsetMs === null ? null : new Date(now.getTime() + offsetMs);
          const prisma = makeTokenPrisma([
            { platform, type: 'access_token', expiresAt: origExpiry, refreshWindowSeconds: 3600, status: 'VALID' },
          ]);
          const tm = new TokenManager(
            prisma,
            createSecretLoader({}),
            { exchange: async () => { throw new Error(`exchange failed: ${reason}`); } },
            new InMemoryAlertDispatcher(),
            fixedClock(now),
          );

          await tm.refresh(platform);
          const row = prisma.__map.get(platform);
          expect(row.expiresAt === null ? null : row.expiresAt.getTime()).toBe(
            origExpiry === null ? null : origExpiry.getTime(),
          );
          expect(row.status).toBe('REFRESH_FAILED');
          expect(typeof row.lastRefreshFailureReason).toBe('string');
          expect(row.lastRefreshFailureReason.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: foundation-and-deployment, Property 15: Token lifecycle alerting
  it('Property 15: EXPIRY when expiry has passed, PRE_EXPIRY_WARNING when within window before refresh, REFRESH_FAILURE on failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.boolean(),
        async (offsetMs, fails) => {
          const now = new Date('2026-01-01T00:00:00Z');
          const expiresAt = new Date(now.getTime() + offsetMs);
          const prisma = makeTokenPrisma([
            // Huge window so the token is always within-window (i.e. selected).
            { platform: 'facebook', type: 'access_token', expiresAt, refreshWindowSeconds: 1_000_000_000, status: 'VALID' },
          ]);
          const alerts = new InMemoryAlertDispatcher();
          const tm = new TokenManager(
            prisma,
            createSecretLoader({}),
            { exchange: async () => { if (fails) throw new Error('boom'); } },
            alerts,
            fixedClock(now),
          );

          await tm.runRefreshCycle(now);
          const kinds = alerts.alerts.map((a) => a.kind);

          if (offsetMs <= 0) expect(kinds).toContain('EXPIRY');
          else expect(kinds).toContain('PRE_EXPIRY_WARNING');

          if (fails) expect(kinds).toContain('REFRESH_FAILURE');
          else expect(kinds).not.toContain('REFRESH_FAILURE');

          // Every raised alert identifies the affected platform.
          for (const a of alerts.alerts) expect(a.platform).toBe('facebook');
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Infrastructure properties (secrets, HMAC, errors, pagination)
// ===========================================================================

describe('foundation-and-deployment infra properties', () => {
  // Feature: foundation-and-deployment, Property 16: Secret values never appear in log output
  it('Property 16: redacted output never contains any tracked secret value', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 6, maxLength: 40 }).map((s) => `sec_${s}`),
        fc.string({ minLength: 6, maxLength: 40 }).map((s) => `tok_${s}`),
        fc.string(),
        (s1, s2, surrounding) => {
          const loader = createSecretLoader({ API_SECRET: s1, AUTH_TOKEN: s2 });
          const line = `${surrounding} secret=${s1} token=${s2} ${surrounding}`;
          const out = loader.redact(line);
          expect(out.includes(s1)).toBe(false);
          expect(out.includes(s2)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 17: Fail-fast on missing required secret
  it('Property 17: a missing required secret aborts (MissingSecretError) naming the secret, leaking no value', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 10_000 }),
        (names, idxSeed) => {
          const missingIdx = idxSeed % names.length;
          const env: Record<string, string> = Object.create(null);
          names.forEach((n, i) => {
            if (i !== missingIdx) env[n] = `val_secret_${i}_xyz`;
          });
          const loader = createSecretLoader(env, []);

          // Startup-style scan reports exactly the (only) missing name.
          expect(firstMissingSecret(loader, names)).toBe(names[missingIdx]);

          let caught: any;
          try {
            loader.require(names[missingIdx]);
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(MissingSecretError);
          expect(caught.secretName).toBe(names[missingIdx]);
          expect(caught.message).toContain(names[missingIdx]); // names the missing secret
          for (const v of Object.values(env)) {
            expect(caught.message.includes(v)).toBe(false); // never leaks a value
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 18: Webhook HMAC verification gate
  it('Property 18: a matching HMAC signature verifies; any mismatch fails', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 8 }), (body, secret) => {
        const sig = computeSignature(secret, body);
        // Matching signature passes (with and without the sha256= prefix).
        expect(verifySignature(secret, body, sig)).toBe(true);
        expect(verifySignature(secret, body, `sha256=${sig}`)).toBe(true);
        // Tampered body or tampered signature fails.
        expect(verifySignature(secret, `${body}x`, sig)).toBe(false);
        expect(
          verifySignature(secret, body, sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a')),
        ).toBe(false);
        expect(verifySignature(secret, body, '')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 19: Responses use only the allowed status codes
  it('Property 19: toErrorBody always yields a status in the allowed set and a JSON {error:{code,message}} body', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .constantFrom<200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 423 | 500 | 502>(
              200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502,
            )
            .map((s) => new AppError(s, 'msg', 'CODE')),
          fc.constant(new ValidationError('bad')),
          fc.constant(new UnauthorizedError()),
          fc.constant(new ForbiddenError()),
          fc.constant(new NotFoundError()),
          fc.constant(new ConflictError()),
          fc.constant(new LockedError()),
          fc.string().map((m) => new Error(m)),
          fc.constant('not-an-error-object'),
        ),
        (err) => {
          const { status, body } = toErrorBody(err, (s) => s);
          expect(ALLOWED_STATUS_CODES.has(status)).toBe(true);
          expect(typeof body.error.code).toBe('string');
          expect(typeof body.error.message).toBe('string');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 19 (set check): ALLOWED_STATUS_CODES is exactly {200,201,202,400,401,403,404,409,423,500,502}', () => {
    expect([...ALLOWED_STATUS_CODES].sort((a, b) => a - b)).toEqual([
      200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502,
    ]);
  });

  // Feature: foundation-and-deployment, Property 20: Pagination contract
  it.skip('Property 20: paginated endpoints return total and at most `limit` records — no pagination helper exists in src; this is a Fastify route-layer concern requiring the HTTP stack/DB (integration test)', () => {
    // There is no pure pagination helper in the foundation source modules
    // (search of src/** found none). The page/limit/total contract is a
    // route-layer behavior over live collection endpoints and is covered by
    // integration tests rather than a pure property test.
  });
});
