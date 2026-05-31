/**
 * Tests for the AI marketing autopilot OPT-IN scheduled jobs (src/infra/jobs.ts).
 *
 * The NodeCronScheduler / node-cron wiring is hard (and wasteful) to unit-test
 * directly, so we test the PURE, env-driven pieces the jobs are built from:
 *   - parseMarketsEnv     — AUTOPILOT_MARKETS parse/validate/default
 *   - parseChannelsEnv    — AUTOPILOT_CHANNELS parse/default
 *   - parseAssetRetryBatch— ASSET_RETRY_BATCH parse/default
 *   - isJobEnabled        — truthy enable-flag check
 *   - selectAssetsToRetry — asset-retry SELECTION (status filter, oldest-first, cap)
 *   - optionalJobsToRegister — which opt-in jobs register given env (OFF by default)
 *
 * optionalJobsToRegister is the seam that decides registration, so asserting it
 * (instead of spinning up real node-cron) gives us the "flags OFF => not
 * registered, flags ON => registered" guarantee deterministically.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  parseMarketsEnv,
  parseChannelsEnv,
  parseAssetRetryBatch,
  isJobEnabled,
  selectAssetsToRetry,
  optionalJobsToRegister,
  DEFAULT_AUTOPILOT_MARKETS,
  DEFAULT_ASSET_RETRY_BATCH,
  AUTOPILOT_CRON_DEFAULTS,
} from '../src/infra/jobs';
import type { RetryableAsset } from '../src/infra/jobs';
import { createSecretLoader } from '../src/infra/secrets';
import { MARKETS, isMarket } from '../src/marketing/markets';
import type { Market } from '../src/marketing/markets';

// --- helpers -----------------------------------------------------------------

/** A SecretLoader backed by a plain env-map (no process.env coupling). */
function loaderFrom(env: Record<string, string | undefined>) {
  return createSecretLoader(env);
}

function asset(id: string, status: string, updatedAtMs: number): RetryableAsset {
  return { id, status, updatedAt: new Date(updatedAtMs) };
}

const ASSET_STATUSES = ['SPEC_READY', 'RENDERING', 'RENDERED', 'FAILED'] as const;
const RETRYABLE = new Set(['SPEC_READY', 'FAILED']);

// =============================================================================
// isJobEnabled
// =============================================================================

describe('isJobEnabled', () => {
  it('is truthy only for true/1/yes (any case, trimmed)', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'YES', ' yes']) {
      expect(isJobEnabled(v)).toBe(true);
    }
    for (const v of ['false', '0', 'no', '', '  ', 'enabled', 'y', 'on', undefined]) {
      expect(isJobEnabled(v)).toBe(false);
    }
  });

  it('never throws and returns a boolean for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (v) => {
        const out = isJobEnabled(v ?? undefined);
        expect(typeof out).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// parseMarketsEnv
// =============================================================================

describe('parseMarketsEnv', () => {
  it('defaults to JAPAN,KOREA,GERMANY,TAIWAN when empty/unset', () => {
    expect(parseMarketsEnv(undefined)).toEqual([...DEFAULT_AUTOPILOT_MARKETS]);
    expect(parseMarketsEnv('')).toEqual([...DEFAULT_AUTOPILOT_MARKETS]);
    expect(parseMarketsEnv('   ')).toEqual([...DEFAULT_AUTOPILOT_MARKETS]);
  });

  it('parses, upper-cases, trims, and keeps only canonical markets', () => {
    expect(parseMarketsEnv('japan, korea')).toEqual(['JAPAN', 'KOREA']);
    expect(parseMarketsEnv(' Germany ')).toEqual(['GERMANY']);
  });

  it('drops unknown markets and de-dupes (first occurrence wins)', () => {
    expect(parseMarketsEnv('JAPAN,MARS,JAPAN,KOREA')).toEqual(['JAPAN', 'KOREA']);
    // all-invalid falls back to the default set
    expect(parseMarketsEnv('MARS,PLUTO')).toEqual([...DEFAULT_AUTOPILOT_MARKETS]);
  });

  it('always returns a non-empty list of valid, unique markets', () => {
    const tokenArb = fc.oneof(
      fc.constantFrom<string>(...MARKETS),
      fc.string({ maxLength: 6 }),
    );
    fc.assert(
      fc.property(fc.array(tokenArb, { maxLength: 12 }), (tokens) => {
        const out = parseMarketsEnv(tokens.join(','));
        expect(out.length).toBeGreaterThan(0);
        // every result is a canonical market
        for (const m of out) expect(isMarket(m)).toBe(true);
        // unique
        expect(new Set(out).size).toBe(out.length);
      }),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// parseChannelsEnv
// =============================================================================

describe('parseChannelsEnv', () => {
  it('returns undefined for empty/unset (planner uses its default matrix)', () => {
    expect(parseChannelsEnv(undefined)).toBeUndefined();
    expect(parseChannelsEnv('')).toBeUndefined();
    expect(parseChannelsEnv('  ')).toBeUndefined();
    expect(parseChannelsEnv(',, ,')).toBeUndefined();
  });

  it('parses, lower-cases, trims, de-dupes a comma list', () => {
    expect(parseChannelsEnv('Facebook, TIKTOK ,facebook')).toEqual(['facebook', 'tiktok']);
    expect(parseChannelsEnv('website')).toEqual(['website']);
  });
});

// =============================================================================
// parseAssetRetryBatch
// =============================================================================

describe('parseAssetRetryBatch', () => {
  it('defaults for missing/invalid/<=0 values', () => {
    for (const v of [undefined, '', '  ', 'abc', '0', '-3', '2.5', 'NaN']) {
      expect(parseAssetRetryBatch(v)).toBe(DEFAULT_ASSET_RETRY_BATCH);
    }
  });

  it('parses a positive integer', () => {
    expect(parseAssetRetryBatch('1')).toBe(1);
    expect(parseAssetRetryBatch(' 10 ')).toBe(10);
  });
});

// =============================================================================
// selectAssetsToRetry
// =============================================================================

describe('selectAssetsToRetry', () => {
  it('keeps only SPEC_READY/FAILED — never RENDERED/RENDERING', () => {
    const assets: RetryableAsset[] = [
      asset('a', 'SPEC_READY', 1),
      asset('b', 'RENDERED', 2),
      asset('c', 'FAILED', 3),
      asset('d', 'RENDERING', 4),
    ];
    const out = selectAssetsToRetry(assets, 10);
    expect(out.map((a) => a.id).sort()).toEqual(['a', 'c']);
    for (const a of out) expect(RETRYABLE.has(a.status)).toBe(true);
  });

  it('orders oldest-first by updatedAt (stable id tie-break)', () => {
    const assets: RetryableAsset[] = [
      asset('z', 'SPEC_READY', 100),
      asset('a', 'FAILED', 100), // same time -> id tie-break: 'a' before 'z'
      asset('m', 'SPEC_READY', 50),
    ];
    const out = selectAssetsToRetry(assets, 10);
    expect(out.map((a) => a.id)).toEqual(['m', 'a', 'z']);
  });

  it('respects the batch cap and returns [] for non-positive batch', () => {
    const assets: RetryableAsset[] = [
      asset('a', 'SPEC_READY', 1),
      asset('b', 'FAILED', 2),
      asset('c', 'SPEC_READY', 3),
    ];
    expect(selectAssetsToRetry(assets, 2).map((a) => a.id)).toEqual(['a', 'b']);
    expect(selectAssetsToRetry(assets, 0)).toEqual([]);
    expect(selectAssetsToRetry(assets, -1)).toEqual([]);
  });

  it('property: result is retryable-only, capped, oldest-first, deterministic', () => {
    const assetArb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      status: fc.constantFrom<string>(...ASSET_STATUSES),
      updatedAt: fc.integer({ min: 0, max: 1_000_000 }).map((ms) => new Date(ms)),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(assetArb, { selector: (a) => a.id, maxLength: 30 }),
        fc.integer({ min: -2, max: 15 }),
        (assets, batch) => {
          const out = selectAssetsToRetry(assets, batch);

          // never returns RENDERED/RENDERING
          for (const a of out) expect(RETRYABLE.has(a.status)).toBe(true);

          // respects the batch cap
          if (batch <= 0) {
            expect(out).toEqual([]);
          } else {
            expect(out.length).toBeLessThanOrEqual(batch);
            const eligible = assets.filter((a) => RETRYABLE.has(a.status));
            expect(out.length).toBe(Math.min(eligible.length, batch));
          }

          // oldest-first by updatedAt (id tie-break) — non-decreasing times
          for (let i = 1; i < out.length; i++) {
            expect(out[i - 1].updatedAt.getTime()).toBeLessThanOrEqual(out[i].updatedAt.getTime());
          }

          // deterministic: same input -> same output
          expect(selectAssetsToRetry(assets, batch).map((a) => a.id)).toEqual(out.map((a) => a.id));
        },
      ),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// optionalJobsToRegister — OPT-IN registration (OFF by default)
// =============================================================================

describe('optionalJobsToRegister', () => {
  it('registers NO optional jobs when flags are unset (default OFF)', () => {
    expect(optionalJobsToRegister(loaderFrom({}))).toEqual([]);
  });

  it('registers NO optional jobs when flags are explicitly falsey', () => {
    const loader = loaderFrom({
      AUTOPILOT_AUTO_RESEARCH: 'false',
      AUTOPILOT_AUTO_PLAN: '0',
      AUTOPILOT_ASSET_RETRY: 'no',
    });
    expect(optionalJobsToRegister(loader)).toEqual([]);
  });

  it('registers each job when its flag is ON, with default crons', () => {
    const loader = loaderFrom({
      AUTOPILOT_AUTO_RESEARCH: 'true',
      AUTOPILOT_AUTO_PLAN: '1',
      AUTOPILOT_ASSET_RETRY: 'yes',
    });
    const jobs = optionalJobsToRegister(loader);
    expect(jobs).toEqual([
      { name: 'auto-market-research', cron: AUTOPILOT_CRON_DEFAULTS.autoResearch },
      { name: 'auto-content-plan', cron: AUTOPILOT_CRON_DEFAULTS.autoPlan },
      { name: 'asset-render-retry', cron: AUTOPILOT_CRON_DEFAULTS.assetRetry },
    ]);
  });

  it('registers only the enabled subset', () => {
    const loader = loaderFrom({ AUTOPILOT_ASSET_RETRY: 'true' });
    const jobs = optionalJobsToRegister(loader);
    expect(jobs.map((j) => j.name)).toEqual(['asset-render-retry']);
  });

  it('honors per-job cron overrides when enabled', () => {
    const loader = loaderFrom({
      AUTOPILOT_AUTO_RESEARCH: 'true',
      CRON_AUTO_RESEARCH: '30 4 * * 2',
    });
    expect(optionalJobsToRegister(loader)).toEqual([
      { name: 'auto-market-research', cron: '30 4 * * 2' },
    ]);
  });
});
