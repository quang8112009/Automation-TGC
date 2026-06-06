/**
 * Privacy & security hardening regression suite.
 *
 * Encodes the concrete gaps surfaced in a security review and asserts the system
 * now fails closed:
 *
 *  1. Time-boxed ADMIN lockout recovery — a threshold lock carries an expiry and
 *     auto-recovers after the cooldown, but a lock WITHOUT an expiry (manual /
 *     legacy) stays locked. So a credential-stuffing burst can't permanently DoS
 *     the only ADMIN, yet manual locks are still honored.
 *  2. Webhook replay protection — a replayed (source, deliveryId) is rejected.
 *  3. Lead webhook idempotency — createFromWebhook with a repeated dedupKey
 *     resolves to the SAME Lead instead of duplicating.
 *  4. Intake HMAC fail-CLOSED — verifySignature('') never verifies.
 *  5. Consent ledger — effective consent fails closed (no record => not granted),
 *     and a later WITHDRAWN overrides an earlier GRANTED.
 *  6. Access-log URL redaction — a `?access_token=` JWT never lands in logs.
 *  7. Retention months parsing — invalid values fall back to the default.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { AuthService } from '../src/auth/authService';
import { JwtService } from '../src/auth/jwt';
import { LockedError } from '../src/infra/errors';
import { verifySignature } from '../src/infra/hmac';
import { recordWebhookDelivery, fingerprintBody } from '../src/infra/webhookReplay';
import { LeadService } from '../src/leads/leadService';
import { ConsentService } from '../src/privacy/consentService';
import { redactUrl } from '../src/http/requestId';
import { parseRetentionMonths } from '../src/privacy/retentionPurgeService';

const JWT_SECRET = 'privacy-regression-signing-secret-which-is-long-enough-0123456789';

// ---------------------------------------------------------------------------
// 1. Time-boxed ADMIN lockout recovery.
// ---------------------------------------------------------------------------
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
        if (username !== undefined) {
          return [...users.values()].find((u) => u.username === username) ?? null;
        }
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
      create: async (args: { data: Record<string, unknown> }) => ({
        sessionId: `sess-${(seq += 1)}`,
        ...args.data,
      }),
    },
  } as unknown as PrismaClient;
  return { prisma, users };
}

function lockedUser(over: Partial<UserRow>): UserRow {
  return {
    id: 'admin-1',
    username: 'admin',
    email: 'a@b.co',
    passwordHash: 'irrelevant-never-verified',
    role: 'ADMIN',
    locked: true,
    lockedAt: new Date(),
    lockedUntil: null,
    failedLoginCount: 5,
    createdAt: new Date(),
    ...over,
  };
}

describe('time-boxed lockout recovery', () => {
  it('a lock WITHOUT an expiry (manual/legacy) stays locked (423)', async () => {
    const { prisma } = authPrisma([lockedUser({ lockedUntil: null })]);
    const svc = new AuthService(prisma, new JwtService(JWT_SECRET, 24, 30), 5, 24, 30, 15);
    await expect(svc.login('admin', 'whatever')).rejects.toBeInstanceOf(LockedError);
  });

  it('a threshold lock still within its cooldown window is rejected (423)', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const { prisma } = authPrisma([lockedUser({ lockedUntil: future })]);
    const svc = new AuthService(prisma, new JwtService(JWT_SECRET, 24, 30), 5, 24, 30, 15);
    await expect(svc.login('admin', 'whatever')).rejects.toBeInstanceOf(LockedError);
  });

  it('auto-recovers a threshold lock once the cooldown has elapsed (clears lock + counter)', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const { prisma, users } = authPrisma([lockedUser({ lockedUntil: past })]);
    const svc = new AuthService(prisma, new JwtService(JWT_SECRET, 24, 30), 5, 24, 30, 15);
    // Password verify will fail (hash is irrelevant) => 401, but the lock must
    // have been cleared first by the auto-recovery path. The failed verify then
    // re-increments the counter from 0 to 1.
    await expect(svc.login('admin', 'whatever')).rejects.toMatchObject({ status: 401 });
    const row = users.get('admin-1');
    expect(row?.locked).toBe(false);
    expect(row?.lockedUntil).toBeNull();
    expect(row?.failedLoginCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Webhook replay protection.
// ---------------------------------------------------------------------------
function replayPrisma(): { prisma: PrismaClient; rows: Array<{ source: string; deliveryId: string }> } {
  const rows: Array<{ source: string; deliveryId: string }> = [];
  const prisma = {
    webhookDelivery: {
      create: async (args: { data: { source: string; deliveryId: string } }) => {
        const dup = rows.some(
          (r) => r.source === args.data.source && r.deliveryId === args.data.deliveryId,
        );
        if (dup) {
          const err = new Error('unique') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        rows.push({ source: args.data.source, deliveryId: args.data.deliveryId });
        return { id: `wd-${rows.length}` };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, rows };
}

describe('webhook replay protection', () => {
  it('accepts the first delivery and rejects an identical replay', async () => {
    const { prisma } = replayPrisma();
    const body = Buffer.from(JSON.stringify({ id: 'evt-1', name: 'A' }));
    const first = await recordWebhookDelivery(prisma, { source: 'lead:facebook', deliveryId: 'evt-1', rawBody: body });
    const second = await recordWebhookDelivery(prisma, { source: 'lead:facebook', deliveryId: 'evt-1', rawBody: body });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('uses a body fingerprint as the delivery id when none is supplied', async () => {
    const { prisma, rows } = replayPrisma();
    const body = Buffer.from('{"a":1}');
    await recordWebhookDelivery(prisma, { source: 'intake:zalo', rawBody: body });
    expect(rows[0].deliveryId).toBe(fingerprintBody(body));
    // Same body again => replay.
    const again = await recordWebhookDelivery(prisma, { source: 'intake:zalo', rawBody: body });
    expect(again).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Lead webhook idempotency.
// ---------------------------------------------------------------------------
function leadPrisma(): PrismaClient {
  const leads = new Map<string, Record<string, unknown>>();
  const byDedup = new Map<string, string>();
  let seq = 0;
  return {
    lead: {
      findUnique: async (args: { where: { dedupKey?: string; leadId?: string } }) => {
        if (args.where.dedupKey !== undefined) {
          const id = byDedup.get(args.where.dedupKey);
          return id ? { ...leads.get(id) } : null;
        }
        if (args.where.leadId !== undefined) return leads.get(args.where.leadId) ?? null;
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const dedupKey = args.data.dedupKey as string | null;
        if (dedupKey && byDedup.has(dedupKey)) {
          const err = new Error('unique') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        const leadId = `lead-${(seq += 1)}`;
        const row = { leadId, ...args.data };
        leads.set(leadId, row);
        if (dedupKey) byDedup.set(dedupKey, leadId);
        return { ...row };
      },
    },
  } as unknown as PrismaClient;
}

describe('lead webhook idempotency', () => {
  it('a repeated dedupKey resolves to the SAME lead (no duplicate)', async () => {
    const svc = new LeadService(leadPrisma());
    const attribution = {
      source: 'facebook_leadgen' as const,
      platform: 'facebook' as const,
      contentPostId: 'post-1',
      unattributed: false,
    };
    const fields = { name: 'A', phone: '1', email: 'a@b.co' };
    const dedupKey = 'lead:facebook:evt-1';
    const a = await svc.createFromWebhook(attribution, fields, dedupKey);
    const b = await svc.createFromWebhook(attribution, fields, dedupKey);
    expect(a.leadId).toBe(b.leadId);
  });
});

// ---------------------------------------------------------------------------
// 4. Intake HMAC fail-closed.
// ---------------------------------------------------------------------------
describe('HMAC fail-closed', () => {
  it('an empty/unset secret never verifies, even with an empty signature', () => {
    const body = Buffer.from('{}');
    expect(verifySignature('', body, '')).toBe(false);
    expect(verifySignature('', body, 'anything')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Consent ledger (fails closed; latest-wins).
// ---------------------------------------------------------------------------
function consentPrisma(): PrismaClient {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    consentRecord: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `c-${(seq += 1)}`, recordedAt: new Date(Date.now() + seq), ...args.data };
        rows.push(row);
        return { ...row };
      },
      findFirst: async (args: {
        where: { subjectType: string; subjectId: string; scope: string };
        orderBy?: unknown;
      }) => {
        const matches = rows
          .filter(
            (r) =>
              r.subjectType === args.where.subjectType &&
              r.subjectId === args.where.subjectId &&
              r.scope === args.where.scope,
          )
          .sort((a, b) => (b.recordedAt as Date).getTime() - (a.recordedAt as Date).getTime());
        return matches[0] ?? null;
      },
    },
  } as unknown as PrismaClient;
}

describe('consent ledger', () => {
  it('fails closed: no record means not consented', async () => {
    const svc = new ConsentService(consentPrisma());
    expect(await svc.hasConsent('LEAD', 'lead-1', 'CROSS_BORDER_AI')).toBe(false);
    expect(await svc.mayTransferToCrossBorderAi('LEAD', 'lead-1')).toBe(false);
  });

  it('latest-wins: a later WITHDRAWN overrides an earlier GRANTED', async () => {
    const svc = new ConsentService(consentPrisma());
    await svc.record({ subjectType: 'LEAD', subjectId: 'lead-1', scope: 'CROSS_BORDER_AI', action: 'GRANTED' });
    expect(await svc.mayTransferToCrossBorderAi('LEAD', 'lead-1')).toBe(true);
    await svc.record({ subjectType: 'LEAD', subjectId: 'lead-1', scope: 'CROSS_BORDER_AI', action: 'WITHDRAWN' });
    expect(await svc.mayTransferToCrossBorderAi('LEAD', 'lead-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Access-log URL redaction.
// ---------------------------------------------------------------------------
describe('access-log URL redaction', () => {
  it('redacts a query-string access_token but preserves path + other params', () => {
    const out = redactUrl('/api/v1/stream?access_token=secret.jwt.value&topics=lead');
    expect(out).toBe('/api/v1/stream?access_token=[REDACTED]&topics=lead');
    expect(out).not.toContain('secret.jwt.value');
  });

  it('leaves a URL without sensitive params unchanged', () => {
    expect(redactUrl('/api/leads?page=2&limit=20')).toBe('/api/leads?page=2&limit=20');
    expect(redactUrl('/healthz')).toBe('/healthz');
  });
});

// ---------------------------------------------------------------------------
// 7. Retention months parsing.
// ---------------------------------------------------------------------------
describe('retention months parsing', () => {
  it('parses a positive integer and falls back on invalid input', () => {
    expect(parseRetentionMonths('6', 12)).toBe(6);
    expect(parseRetentionMonths(undefined, 12)).toBe(12);
    expect(parseRetentionMonths('', 12)).toBe(12);
    expect(parseRetentionMonths('0', 12)).toBe(12);
    expect(parseRetentionMonths('-3', 12)).toBe(12);
    expect(parseRetentionMonths('abc', 12)).toBe(12);
    expect(parseRetentionMonths('1.5', 12)).toBe(12);
  });
});
