/**
 * Tests for the production manual-mode TokenRefresher wiring.
 *
 * Regression intent: the old default refresher RESOLVED while doing nothing, so
 * `runRefreshCycle` silently advanced a token's expiry (e.g. Facebook +60d)
 * WITHOUT a real exchange — masking a genuinely-expiring token and suppressing
 * its alerts. The manual-mode refresher fails honestly so the cycle RETAINS the
 * real expiry and raises REFRESH_FAILURE, prompting an operator to act.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  TokenManager,
  type TokenType,
} from '../src/tokens/tokenManager';
import {
  createManualModeRefresher,
  TokenRefreshNotConfiguredError,
} from '../src/tokens/platformTokenRefresher';
import { InMemoryAlertDispatcher } from '../src/infra/alerts';
import type { SecretLoader } from '../src/infra/secrets';

/** Minimal in-memory PlatformToken store matching what TokenManager touches. */
interface Row {
  platform: string;
  type: string;
  expiresAt: Date | null;
  refreshWindowSeconds: number;
  status: string;
  lastRefreshFailureReason?: string | null;
}

function makeTokenPrisma(seed: Row[]): PrismaClient & { __map: Map<string, Row> } {
  const map = new Map<string, Row>();
  for (const r of seed) map.set(r.platform, { ...r });
  const prisma = {
    __map: map,
    platformToken: {
      findUnique: async (a: { where: { platform: string } }) => {
        const r = map.get(a.where.platform);
        return r ? { ...r } : null;
      },
      findMany: async () => [...map.values()].map((r) => ({ ...r })),
      upsert: async (a: {
        where: { platform: string };
        create: Row;
        update: Partial<Row>;
      }) => {
        const existing = map.get(a.where.platform);
        if (existing) {
          Object.assign(existing, a.update);
          return { ...existing };
        }
        const created = { ...a.create };
        map.set(created.platform, created);
        return { ...created };
      },
    },
  } as unknown as PrismaClient & { __map: Map<string, Row> };
  return prisma;
}

/** SecretLoader stub: no platform token values configured + identity redact. */
function fakeSecrets(): SecretLoader {
  return {
    require: (k: string) => {
      throw new Error(`missing ${k}`);
    },
    optional: () => undefined,
    redact: (s: string) => s,
  } as unknown as SecretLoader;
}

function fixedClock(now: Date) {
  return { now: () => now };
}

const NOW = new Date('2026-01-01T00:00:00Z');

describe('manual-mode TokenRefresher', () => {
  it('exchange() throws TokenRefreshNotConfiguredError naming the platform', async () => {
    const refresher = createManualModeRefresher();
    await expect(refresher.exchange('facebook', NOW)).rejects.toBeInstanceOf(
      TokenRefreshNotConfiguredError,
    );
    await expect(refresher.exchange('facebook', NOW)).rejects.toThrow(/facebook/);
  });

  it('refresh() RETAINS the prior expiry (does not mask) and records REFRESH_FAILED', async () => {
    const priorExpiry = new Date(NOW.getTime() + 5 * 86_400_000); // +5 days, within window
    const prisma = makeTokenPrisma([
      {
        platform: 'facebook',
        type: 'access_token' as TokenType,
        expiresAt: priorExpiry,
        refreshWindowSeconds: 7 * 86_400, // 7-day window -> token is within it
        status: 'VALID',
      },
    ]);
    const tm = new TokenManager(
      prisma,
      fakeSecrets(),
      createManualModeRefresher(),
      new InMemoryAlertDispatcher(),
      fixedClock(NOW),
    );

    await tm.refresh('facebook');

    const row = prisma.__map.get('facebook')!;
    // Crucially NOT advanced to NOW+60d — the prior expiry is retained.
    expect(row.expiresAt?.getTime()).toBe(priorExpiry.getTime());
    expect(row.status).toBe('REFRESH_FAILED');
    expect(typeof row.lastRefreshFailureReason).toBe('string');
    expect((row.lastRefreshFailureReason ?? '').length).toBeGreaterThan(0);
  });

  it('runRefreshCycle raises PRE_EXPIRY_WARNING + REFRESH_FAILURE for an in-window token (no masking)', async () => {
    const priorExpiry = new Date(NOW.getTime() + 2 * 86_400_000); // +2 days
    const prisma = makeTokenPrisma([
      {
        platform: 'facebook',
        type: 'access_token' as TokenType,
        expiresAt: priorExpiry,
        refreshWindowSeconds: 7 * 86_400,
        status: 'VALID',
      },
    ]);
    const alerts = new InMemoryAlertDispatcher();
    const tm = new TokenManager(prisma, fakeSecrets(), createManualModeRefresher(), alerts, fixedClock(NOW));

    await tm.runRefreshCycle(NOW);

    const kinds = alerts.alerts.map((a) => a.kind);
    expect(kinds).toContain('PRE_EXPIRY_WARNING');
    expect(kinds).toContain('REFRESH_FAILURE');
    // Expiry retained (not masked to +60d).
    expect(prisma.__map.get('facebook')!.expiresAt?.getTime()).toBe(priorExpiry.getTime());
  });

  it('runRefreshCycle SKIPS a non-expiring token (expiresAt null) -> no failure noise', async () => {
    const prisma = makeTokenPrisma([
      {
        platform: 'facebook',
        type: 'service_account' as TokenType,
        expiresAt: null, // non-expiring (e.g. FB System User token)
        refreshWindowSeconds: 7 * 86_400,
        status: 'VALID',
      },
    ]);
    const alerts = new InMemoryAlertDispatcher();
    const tm = new TokenManager(prisma, fakeSecrets(), createManualModeRefresher(), alerts, fixedClock(NOW));

    await tm.runRefreshCycle(NOW);

    expect(alerts.alerts).toHaveLength(0);
    expect(prisma.__map.get('facebook')!.expiresAt).toBeNull();
  });
});
