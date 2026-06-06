/**
 * Unit tests for the SALES access-restrictions feature (spec tasks 13.1-13.4).
 *
 * These are example-based Vitest unit tests over service / shape behavior using
 * in-memory Prisma fakes (mirroring `recruitment.test.ts`). No real database.
 *
 * Coverage:
 *  - 13.1 Platform token public view & refresh expose NO secret value fields.
 *  - 13.2 KnowledgeService.create → active=true; deactivate → soft-delete (active=false, row preserved).
 *  - 13.3 FollowUpService.list scoping: SALES → candidateId-in-owned constraint; ADMIN → no constraint.
 *  - 13.4 AuthorizationAuditor denied audit detail carries metadata only (no secrets).
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../src/http/authMiddleware';
import { TokenManager } from '../src/tokens/tokenManager';
import type { PublicTokenView, TokenRefresher } from '../src/tokens/tokenManager';
import type { SecretLoader } from '../src/infra/secrets';
import type { AlertDispatcher } from '../src/infra/alerts';
import { KnowledgeService } from '../src/recruitment/knowledge/knowledgeService';
import { FollowUpService } from '../src/intake/followUpService';
import { AuthorizationAuditor } from '../src/oversight/authorizationAuditor';
import type { ActivityLogger } from '../src/oversight/activityLogger';

// ---- Shared doubles ---------------------------------------------------------

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-admin' };
const SALES: AuthInfo = { userId: 'sales-1', role: 'SALES', sessionId: 'sess-sales' };

/** Field names that must NEVER appear in a secret-free public view / audit detail. */
const SECRET_FIELDS = [
  'token',
  'tokens',
  'secret',
  'value',
  'credential',
  'credentials',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'apiKey',
  'api_key',
  'apikey',
  'password',
  'key',
];

function assertNoSecretFields(obj: Record<string, unknown>): void {
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  for (const secret of SECRET_FIELDS) {
    expect(keys).not.toContain(secret.toLowerCase());
  }
}

// =============================================================================
// 13.1 — Token view & refresh metadata (Req 1.1, 1.2)
// =============================================================================

/** SecretLoader fake — `optional` returns a usable value, `redact` is identity-ish. */
function fakeSecrets(): SecretLoader {
  return {
    optional: (_name: string) => 'a-usable-secret-token-value',
    redact: (msg: string) => msg,
  } as unknown as SecretLoader;
}

/** Always-succeeding token refresher. */
const okRefresher: TokenRefresher = {
  exchange: async () => {
    /* success: no-op */
  },
};

/** No-op alert dispatcher. */
const noopAlerts: AlertDispatcher = {
  raise: async () => {
    /* no-op */
  },
} as unknown as AlertDispatcher;

/** Prisma fake exposing platformToken metadata rows for list + refresh. */
function fakeTokenPrisma(): PrismaClient {
  const row = {
    platform: 'facebook',
    type: 'access_token',
    expiresAt: new Date('2999-01-01T00:00:00.000Z'),
    refreshWindowSeconds: 3600,
    status: 'VALID',
    lastRefreshFailureReason: null,
  };
  return {
    platformToken: {
      findMany: async () => [row],
      findUnique: async () => row,
      upsert: async () => row,
    },
  } as unknown as PrismaClient;
}

describe('13.1 PublicTokenView exposes no secret value fields', () => {
  const fixedClock = { now: () => new Date('2024-01-01T00:00:00.000Z') };

  it('listPublic() returns metadata-only views (platform/type/expiresAt/valid) with no secret', async () => {
    const manager = new TokenManager(fakeTokenPrisma(), fakeSecrets(), okRefresher, noopAlerts, fixedClock);
    const views = await manager.listPublic();

    expect(views).toHaveLength(1);
    const view = views[0];

    // Exact metadata shape — these are the only allowed keys.
    expect(Object.keys(view).sort()).toEqual(['expiresAt', 'platform', 'type', 'valid']);
    expect(view.platform).toBe('facebook');
    expect(view.type).toBe('access_token');
    expect(typeof view.valid).toBe('boolean');

    // Key assertion: no secret-bearing field present.
    assertNoSecretFields(view as unknown as Record<string, unknown>);
  });

  it('refresh() returns updated metadata only, never the secret value', async () => {
    const manager = new TokenManager(fakeTokenPrisma(), fakeSecrets(), okRefresher, noopAlerts, fixedClock);
    const view: PublicTokenView = await manager.refresh('facebook');

    expect(Object.keys(view).sort()).toEqual(['expiresAt', 'platform', 'type', 'valid']);
    expect(view.platform).toBe('facebook');

    // The refreshed view carries status/expiry metadata only — no secret.
    assertNoSecretFields(view as unknown as Record<string, unknown>);

    // Defensively confirm no value in the serialized form either.
    const serialized = JSON.stringify(view).toLowerCase();
    expect(serialized).not.toContain('a-usable-secret-token-value');
  });
});

// =============================================================================
// 13.2 — KnowledgeService create / deactivate (Req 1.6, 1.8)
// =============================================================================

interface KnowledgeCalls {
  created: Array<Record<string, unknown>>;
  updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  deleted: Array<Record<string, unknown>>;
}

/** Prisma fake for KnowledgeService capturing create/update/delete calls. */
function fakeKnowledgePrisma(): { prisma: PrismaClient; calls: KnowledgeCalls } {
  const calls: KnowledgeCalls = { created: [], updated: [], deleted: [] };
  const prisma = {
    knowledgeEntry: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.created.push(args.data);
        return { id: 'kb-1', tags: [], market: null, ...args.data };
      },
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updated.push(args);
        return { id: 'kb-1', category: 'visa', title: 'T', content: 'C', tags: [], market: null, active: false, ...args.data };
      },
      delete: async (args: { where: Record<string, unknown> }) => {
        calls.deleted.push(args.where);
        return { id: 'kb-1' };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

describe('13.2 KnowledgeService create/deactivate', () => {
  it('create() produces an entry with active === true', async () => {
    const { prisma, calls } = fakeKnowledgePrisma();
    const service = new KnowledgeService(prisma);

    const entry = await service.create({ category: 'visa', title: 'TOKUTEI overview', content: 'body' });

    expect(calls.created).toHaveLength(1);
    expect(calls.created[0].active).toBe(true);
    expect(entry.active).toBe(true);
    expect(calls.deleted).toHaveLength(0);
  });

  it('deactivate() is a soft delete: updates active:false and never deletes the row', async () => {
    const { prisma, calls } = fakeKnowledgePrisma();
    const service = new KnowledgeService(prisma);

    const entry = await service.deactivate('kb-1');

    // Exactly one update with active:false; the row is preserved (no delete).
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].where).toEqual({ id: 'kb-1' });
    expect(calls.updated[0].data).toEqual({ active: false });
    expect(calls.deleted).toHaveLength(0);
    expect(entry.active).toBe(false);
  });
});

// =============================================================================
// 13.3 — FollowUpService.list scoping (Req 3.6, 4.4)
// =============================================================================

interface FollowUpWhereCapture {
  findManyWhere: Array<Record<string, unknown>>;
  countWhere: Array<Record<string, unknown>>;
}

/**
 * Prisma fake where candidateProfile.findMany returns ids owned by sales-1, and
 * followUpTask.findMany/count echo (capture) the `where` they receive.
 */
function fakeFollowUpPrisma(ownedIds: string[]): { prisma: PrismaClient; capture: FollowUpWhereCapture } {
  const capture: FollowUpWhereCapture = { findManyWhere: [], countWhere: [] };
  const prisma = {
    candidateProfile: {
      findMany: async () => ownedIds.map((id) => ({ id })),
    },
    followUpTask: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        capture.findManyWhere.push(args.where);
        return [];
      },
      count: async (args: { where: Record<string, unknown> }) => {
        capture.countWhere.push(args.where);
        return 0;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, capture };
}

describe('13.3 FollowUpService.list scoping', () => {
  it('SALES is constrained to candidateId in the owned-candidate set', async () => {
    const ownedIds = ['cand-a', 'cand-b'];
    const { prisma, capture } = fakeFollowUpPrisma(ownedIds);
    const service = new FollowUpService(prisma);

    await service.list(undefined, 1, 20, SALES);

    expect(capture.findManyWhere).toHaveLength(1);
    const where = capture.findManyWhere[0];
    // Tasks with null/other candidate are excluded via `candidateId in {owned}`.
    expect(where.candidateId).toEqual({ in: ownedIds });
    // The count query is scoped identically.
    expect(capture.countWhere[0].candidateId).toEqual({ in: ownedIds });
  });

  it('SALES with no owned candidates gets an empty in-list (fail-closed)', async () => {
    const { prisma, capture } = fakeFollowUpPrisma([]);
    const service = new FollowUpService(prisma);

    await service.list(undefined, 1, 20, SALES);

    expect(capture.findManyWhere[0].candidateId).toEqual({ in: [] });
  });

  it('ADMIN gets no candidateId constraint', async () => {
    const { prisma, capture } = fakeFollowUpPrisma(['cand-a']);
    const service = new FollowUpService(prisma);

    await service.list(undefined, 1, 20, ADMIN);

    expect(capture.findManyWhere).toHaveLength(1);
    expect(capture.findManyWhere[0].candidateId).toBeUndefined();
  });
});

// =============================================================================
// 13.4 — Audit detail contains no secrets (Req 7.4)
// =============================================================================

interface AppendCapture {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
}

/**
 * ActivityLogger fake that captures append() input synchronously. `recordDenied`
 * is fire-and-forget (void) but invokes `append` synchronously before returning,
 * so the captured value is available immediately after the call.
 */
function fakeLogger(): { logger: ActivityLogger; calls: AppendCapture[] } {
  const calls: AppendCapture[] = [];
  const logger = {
    append: (input: AppendCapture) => {
      calls.push(input);
      return Promise.resolve({ id: 'log-1', createdAt: new Date(), ...input });
    },
  } as unknown as ActivityLogger;
  return { logger, calls };
}

describe('13.4 AuthorizationAuditor denied audit detail carries no secrets', () => {
  it('recordDenied records module/action metadata only — no token/secret/password/key', () => {
    const { logger, calls } = fakeLogger();
    const auditor = new AuthorizationAuditor(logger);

    auditor.recordDenied({
      actorUserId: 'sales-1',
      module: 'platform_tokens',
      action: 'update',
      targetId: 'facebook',
    });

    expect(calls).toHaveLength(1);
    const record = calls[0];

    expect(record.action).toBe('AUTHZ_DENIED');
    expect(record.targetType).toBe('authorization');
    expect(record.actorUserId).toBe('sales-1');

    // detail holds only metadata (module, action).
    expect(record.detail).toEqual({ module: 'platform_tokens', action: 'update' });
    assertNoSecretFields(record.detail);

    // No secret-bearing field anywhere in the serialized record.
    const serialized = JSON.stringify(record).toLowerCase();
    for (const word of ['secret', 'password', 'credential']) {
      expect(serialized).not.toContain(word);
    }
  });
});
