/**
 * Security-hardening regression suite.
 *
 * Each test encodes a concrete attack that was possible before the fix and
 * asserts the system now fails closed. Grouped by vulnerability class:
 *
 *  1. Privilege escalation via public ADMIN self-registration.
 *  2. Webhook HMAC fail-open when the secret is unconfigured (empty key).
 *  3. Realtime per-recipient authorization (SALES cross-tenant event leak).
 *  4. Pagination limit clamp (unbounded Prisma `take` / DoS amplifier).
 *
 * Pure helpers are tested directly; AuthService is exercised against the same
 * in-memory Prisma fake shape used by the other auth suites.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';

import { AuthService } from '../src/auth/authService';
import { JwtService } from '../src/auth/jwt';
import { ForbiddenError } from '../src/infra/errors';
import { computeSignature, verifySignature } from '../src/infra/hmac';
import { isEventForRecipient } from '../src/realtime/topics';
import type { DomainEvent } from '../src/infra/events';

const JWT_SECRET = 'security-regression-signing-secret-which-is-long-enough-0123456789';

// ---------------------------------------------------------------------------
// In-memory Prisma fake (userAccount + jwtSession) for AuthService.register.
// ---------------------------------------------------------------------------
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

function fakePrisma(seed: UserRow[] = []): { prisma: PrismaClient; users: Map<string, UserRow> } {
  const users = new Map<string, UserRow>();
  for (const u of seed) users.set(u.id, { ...u });
  let seq = 0;

  const prisma = {
    userAccount: {
      count: async () => users.size,
      findUnique: async (args: { where: { id?: string; username?: string } }) => {
        const { id, username } = args.where;
        if (id !== undefined) return users.get(id) ?? null;
        if (username !== undefined) {
          return [...users.values()].find((u) => u.username === username) ?? null;
        }
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const n = (seq += 1);
        const row: UserRow = {
          id: `user-${n}`,
          username: String(args.data.username),
          email: String(args.data.email),
          passwordHash: String(args.data.passwordHash),
          role: String(args.data.role ?? 'SALES'),
          locked: false,
          lockedAt: null,
          failedLoginCount: 0,
          createdAt: new Date(Date.UTC(2024, 0, 1) + n * 1000),
        };
        users.set(row.id, row);
        return { ...row };
      },
    },
    jwtSession: {
      create: async (args: { data: Record<string, unknown> }) => ({
        sessionId: `sess-${(seq += 1)}`,
        ...args.data,
      }),
    },
  } as unknown as PrismaClient;

  return { prisma, users };
}

function newAuthService(prisma: PrismaClient): AuthService {
  return new AuthService(prisma, new JwtService(JWT_SECRET, 24, 30), 5);
}

const GOOD_REGISTRATION = {
  username: 'founder',
  email: 'founder@autotgc.local',
  password: 'password123',
  passwordConfirmation: 'password123',
};

// ===========================================================================
// 1. Privilege escalation — public ADMIN self-registration
// ===========================================================================
describe('Security: public registration is bootstrap-only (privilege-escalation guard)', () => {
  it('allows the FIRST account (bootstrap) and mints it ADMIN', async () => {
    const { prisma, users } = fakePrisma([]);
    const svc = newAuthService(prisma);

    const result = await svc.register(GOOD_REGISTRATION);

    expect(result.user.role).toBe('ADMIN');
    expect(users.size).toBe(1);
  });

  it('rejects registration with 403 once ANY account exists (closed thereafter)', async () => {
    const { prisma } = fakePrisma([]);
    const svc = newAuthService(prisma);

    // Bootstrap the first admin.
    await svc.register(GOOD_REGISTRATION);

    // The attack: an anonymous caller tries to self-register a second ADMIN.
    let err: unknown;
    try {
      await svc.register({
        username: 'attacker',
        email: 'attacker@evil.example',
        password: 'password123',
        passwordConfirmation: 'password123',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).status).toBe(403);
    expect((err as ForbiddenError).code).toBe('REGISTRATION_CLOSED');
  });

  it('stays closed regardless of how many accounts already exist', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 25 }), async (existing) => {
        const seed: UserRow[] = Array.from({ length: existing }, (_v, i) => ({
          id: `seed-${i}`,
          username: `user${i}`,
          email: `user${i}@x.co`,
          passwordHash: 'x',
          role: i === 0 ? 'ADMIN' : 'SALES',
          locked: false,
          lockedAt: null,
          failedLoginCount: 0,
          createdAt: new Date(),
        }));
        const { prisma } = fakePrisma(seed);
        const svc = newAuthService(prisma);
        await expect(svc.register(GOOD_REGISTRATION)).rejects.toBeInstanceOf(ForbiddenError);
      }),
      { numRuns: 30 },
    );
  });
});

// ===========================================================================
// 2. Webhook HMAC fail-open — empty/absent secret must never verify
// ===========================================================================
describe('Security: webhook HMAC fails closed on an empty secret', () => {
  it('rejects any signature when the secret is empty, even a "correctly" computed one', () => {
    // The attack: an unconfigured webhook secret ('') let an attacker sign the
    // body with the empty key and forge a valid-looking signature.
    fc.assert(
      fc.property(fc.string(), (body) => {
        const forged = computeSignature('', body); // what an attacker would compute
        expect(verifySignature('', body, forged)).toBe(false);
        expect(verifySignature('', body, `sha256=${forged}`)).toBe(false);
        expect(verifySignature('', body, 'anything')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('still verifies correctly when a real secret is configured', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 8 }), (body, secret) => {
        const sig = computeSignature(secret, body);
        expect(verifySignature(secret, body, sig)).toBe(true);
        expect(verifySignature(secret, `${body}x`, sig)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// 3. Realtime per-recipient authorization (SALES cross-tenant leak)
// ===========================================================================
describe('Security: realtime events are scoped to the recipient (SALES assigned-only)', () => {
  const event = (payload: Record<string, unknown>): Pick<DomainEvent, 'payload'> => ({ payload });

  it('ADMIN receives every event regardless of owner', () => {
    expect(isEventForRecipient('ADMIN', 'admin-1', event({}))).toBe(true);
    expect(isEventForRecipient('ADMIN', 'admin-1', event({ assignedTo: 'someone-else' }))).toBe(true);
  });

  it('SALES receives an event ONLY when it is assigned to them', () => {
    expect(isEventForRecipient('SALES', 'sales-1', event({ assignedTo: 'sales-1' }))).toBe(true);
    expect(isEventForRecipient('SALES', 'sales-1', event({ recipientUserId: 'sales-1' }))).toBe(true);
    // Belongs to another consultant -> denied.
    expect(isEventForRecipient('SALES', 'sales-1', event({ assignedTo: 'sales-2' }))).toBe(false);
  });

  it('SALES fails closed when the event carries no owner (unscoped lead/notification)', () => {
    expect(isEventForRecipient('SALES', 'sales-1', event({}))).toBe(false);
    expect(isEventForRecipient('SALES', 'sales-1', event({ assignedTo: null }))).toBe(false);
    expect(isEventForRecipient('SALES', 'sales-1', event({ id: 'lead-9', status: 'NEW' }))).toBe(false);
  });

  it('property: a SALES user never receives an event owned by a different user', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
        (me, owner) => {
          const allowed = isEventForRecipient('SALES', me, event({ assignedTo: owner }));
          // Allowed iff there is an owner AND it is exactly me.
          expect(allowed).toBe(owner !== null && owner === me);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// 4. Pagination limit clamp — unbounded `take` (DoS amplifier)
// ===========================================================================
import { LeadService } from '../src/leads/leadService';
import type { AuthInfo } from '../src/http/authMiddleware';

/**
 * Minimal lead prisma fake that records the `take` argument passed to findMany,
 * so we can assert the service never asks the DB for an unbounded page.
 */
function makeLeadProbePrisma(total: number): { prisma: PrismaClient; lastTake: () => number | undefined } {
  let lastTake: number | undefined;
  const rows = Array.from({ length: total }, (_v, i) => ({
    leadId: `L${i}`,
    status: 'NEW',
    source: 'website_form',
    assignedTo: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
  }));
  const prisma = {
    lead: {
      findMany: async (args: { skip?: number; take?: number }) => {
        lastTake = args.take;
        const skip = args.skip ?? 0;
        const take = args.take ?? rows.length;
        return rows.slice(skip, skip + take).map((r) => ({ ...r }));
      },
      count: async () => rows.length,
    },
  } as unknown as PrismaClient;
  return { prisma, lastTake: () => lastTake };
}

describe('Security: lead list clamps an oversized page size', () => {
  const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-admin' };

  it('caps `take` at the MAX_PAGE_SIZE ceiling for a hostile limit', async () => {
    const { prisma, lastTake } = makeLeadProbePrisma(50);
    const svc = new LeadService(prisma);

    // The attack: request an enormous page to force an unbounded DB read.
    await svc.list({}, 1, 5_000_000, ADMIN);

    expect(lastTake()).toBeDefined();
    expect(lastTake() as number).toBeLessThanOrEqual(1000);
  });

  it('honors a normal limit unchanged', async () => {
    const { prisma, lastTake } = makeLeadProbePrisma(50);
    const svc = new LeadService(prisma);
    await svc.list({}, 1, 25, ADMIN);
    expect(lastTake()).toBe(25);
  });
});

// ===========================================================================
// 5. SSRF hardening — Custom CMS base URL must use http(s)
// ===========================================================================
import { CustomCmsAdapter } from '../src/platforms/customCmsAdapter';
import type { PlatformId } from '../src/platforms/adapter';
import type { PlatformTokenProvider } from '../src/platforms/tokenProvider';
import type { HttpClient } from '../src/platforms/httpClient';

function cmsTokens(value: string | undefined): PlatformTokenProvider {
  return { getTokenValue: (_p: PlatformId) => value };
}

function noopHttp(): HttpClient {
  return {
    async post() {
      return { status: 200, ok: true, body: { id: 'p1' } };
    },
    async get() {
      return { status: 200, ok: true, body: {} };
    },
  };
}

describe('Security: Custom CMS adapter rejects non-http(s) base URLs (SSRF guard)', () => {
  const cmsPublish = {
    draftId: 'd1',
    title: 'T',
    body: 'B',
    ctas: [],
    idempotencyKey: 'k1',
  };

  it.each(['file:///etc/passwd', 'gopher://127.0.0.1:6379/_INFO', 'ftp://internal/host'])(
    'rejects dangerous scheme %s with a 502 before any HTTP call',
    async (badUrl) => {
      const adapter = new CustomCmsAdapter({
        tokens: cmsTokens('valid-token'),
        httpClient: noopHttp(),
        baseUrl: badUrl,
      });
      let err: unknown;
      try {
        await adapter.publish({ ...cmsPublish });
      } catch (e) {
        err = e;
      }
      expect((err as { status?: number }).status).toBe(502);
    },
  );

  it('accepts a normal https base URL', async () => {
    const adapter = new CustomCmsAdapter({
      tokens: cmsTokens('valid-token'),
      httpClient: noopHttp(),
      baseUrl: 'https://cms.example.test/api/v1',
    });
    await expect(adapter.publish({ ...cmsPublish })).resolves.toMatchObject({ externalId: 'p1' });
  });
});
