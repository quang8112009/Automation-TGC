import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  AdapterRegistry,
  BasePlatformAdapter,
} from '../src/platforms/registry';
import {
  UnsupportedOperationError,
  UnsupportedPlatformError,
} from '../src/platforms/adapter';
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
  computeRefreshedExpiry,
  isTokenValid,
} from '../src/tokens/tokenManager';

const ALL_PLATFORMS: PlatformId[] = ['facebook', 'tiktok', 'custom_cms', 'ga4'];

/** Test adapter whose capability matrix is configurable. */
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

  async collectAnalytics(_query: AnalyticsQuery): Promise<AnalyticsResult> {
    this.assertSupported('analytics');
    return { metrics: {}, raw: {} };
  }
}

describe('foundation platform integration', () => {
  // Feature: foundation-and-deployment, Property 10: Adapter registry routing correctness
  it('Property 10: registration is additive and get() routes to the matching adapter', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ALL_PLATFORMS), { minLength: 1, maxLength: 4 }),
        (platforms) => {
          const registry = new AdapterRegistry();
          const registered: PlatformId[] = [];
          for (const p of platforms) {
            registry.register(new FakeAdapter(p, ['publish', 'analytics']));
            registered.push(p);
            // Additive: every previously registered platform still resolves.
            for (const r of registered) {
              expect(registry.has(r)).toBe(true);
              expect(registry.get(r).platform).toBe(r);
            }
          }
          expect(new Set(registry.list())).toEqual(new Set(platforms));
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 10: Adapter registry routing correctness
  it('Property 10: unknown platform -> UnsupportedPlatformError', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ALL_PLATFORMS), { minLength: 0, maxLength: 4 }),
        (present) => {
          const registry = new AdapterRegistry();
          for (const p of present) {
            registry.register(new FakeAdapter(p, ['analytics']));
          }
          for (const p of ALL_PLATFORMS) {
            if (present.includes(p)) continue;
            expect(registry.has(p)).toBe(false);
            let thrown: unknown;
            try {
              registry.get(p);
            } catch (err) {
              thrown = err;
            }
            expect(thrown).toBeInstanceOf(UnsupportedPlatformError);
            expect((thrown as UnsupportedPlatformError).status).toBe(400);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 10: Adapter registry routing correctness
  it('Property 10: unimplemented capability -> UnsupportedOperationError (400)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_PLATFORMS),
        fc.subarray<Capability>(['publish', 'analytics']),
        async (platform, caps) => {
          const adapter: PlatformAdapter = new FakeAdapter(platform, caps);
          for (const op of ['publish', 'analytics'] as Capability[]) {
            const call =
              op === 'publish'
                ? adapter.publish({
                    draftId: 'd',
                    title: 't',
                    body: 'b',
                    ctas: [],
                    idempotencyKey: 'k',
                  })
                : adapter.collectAnalytics({});
            if (adapter.supports(op)) {
              await expect(call).resolves.toBeDefined();
            } else {
              await expect(call).rejects.toBeInstanceOf(UnsupportedOperationError);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 12: Token validity predicate
  it('Property 12: valid iff value present AND (non-expiring OR expiry in the future)', () => {
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

  // Feature: foundation-and-deployment, Property 13: Refresh cycle expiry update
  it('Property 13: facebook refresh -> now + 60d, tiktok -> now + 24h', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2100-01-01') }),
        fc.option(fc.integer({ min: -10_000_000, max: 10_000_000 }), { nil: null }),
        (now, currentOffset) => {
          const currentExpiry =
            currentOffset === null ? null : new Date(now.getTime() + currentOffset);

          const fb = computeRefreshedExpiry('facebook', now, currentExpiry);
          const tk = computeRefreshedExpiry('tiktok', now, currentExpiry);
          const other = computeRefreshedExpiry('ga4', now, currentExpiry);

          expect(fb?.getTime()).toBe(now.getTime() + 60 * 86_400_000);
          expect(tk?.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
          // Unknown refresh rule retains the current expiry unchanged.
          expect(other).toBe(currentExpiry);
        },
      ),
      { numRuns: 300 },
    );
  });
});
