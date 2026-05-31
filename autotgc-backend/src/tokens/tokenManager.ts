/**
 * Token_Manager — platform token metadata, validity, refresh, and the refresh
 * cycle with lifecycle alerting (Foundation Req 10.x, 11.x, 12.x).
 *
 * Secret values are NEVER stored in the database: the PlatformToken row holds
 * only metadata (platform, type, expiry, refresh window, status). The actual
 * token value lives in the Secret_Store and is read on demand through the
 * SecretLoader. The public view never exposes the value.
 */
import type { PrismaClient } from '@prisma/client';
import type { SecretLoader } from '../infra/secrets';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import type { AlertDispatcher, AlertKind } from '../infra/alerts';
import type { EventBus } from '../infra/events';
import type { PlatformId } from '../platforms/adapter';
import type { PlatformTokenProvider } from '../platforms/tokenProvider';
import { isUsableTokenValue } from '../platforms/tokenProvider';

/** Token type taxonomy (API_Catalog §6.1). */
export type TokenType = 'access_token' | 'refresh_token' | 'api_key' | 'service_account';

/** Public, secret-free view returned by the API. */
export interface PublicTokenView {
  platform: string;
  type: string;
  expiresAt: Date | null;
  valid: boolean;
}

/**
 * Per-platform refresh seam. The concrete implementation performs the external
 * token-exchange HTTP call; tests inject a mock to make refresh deterministic.
 * Throws on a failed exchange.
 */
export interface TokenRefresher {
  exchange(platform: string, now: Date): Promise<void>;
}

const DAY_MS = 86_400_000;
const FACEBOOK_REFRESH_MS = 60 * DAY_MS; // long-lived token: +60 days
const TIKTOK_REFRESH_MS = 24 * 60 * 60 * 1000; // access token: +24 hours

/**
 * Pure: the new expiry after a successful refresh for a platform.
 * Facebook -> now + 60 days, TikTok -> now + 24 hours; any other platform
 * retains its current expiry (no known refresh rule).
 */
export function computeRefreshedExpiry(
  platform: string,
  now: Date,
  currentExpiry: Date | null,
): Date | null {
  if (platform === 'facebook') return new Date(now.getTime() + FACEBOOK_REFRESH_MS);
  if (platform === 'tiktok') return new Date(now.getTime() + TIKTOK_REFRESH_MS);
  return currentExpiry;
}

/**
 * Pure validity predicate (Req 10.5): valid iff a value is configured AND the
 * token is non-expiring (expiresAt null) OR its expiry is strictly in the future.
 */
export function isTokenValid(hasValue: boolean, expiresAt: Date | null, now: Date): boolean {
  if (!hasValue) return false;
  if (expiresAt === null) return true;
  return expiresAt.getTime() > now.getTime();
}

/** Environment/secret key holding a platform's token value. */
export function platformSecretName(platform: string): string {
  return `PLATFORM_TOKEN_${platform.toUpperCase()}`;
}

interface TokenRow {
  platform: string;
  type: string;
  expiresAt: Date | null;
  refreshWindowSeconds: number;
}

export class TokenManager implements PlatformTokenProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretLoader,
    private readonly refresher: TokenRefresher,
    private readonly alerts: AlertDispatcher,
    private readonly clock: Clock = systemClock,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Raise a token alert AND mirror it on the 'token_alert' event topic so the
   * real-time layer can surface it. The DB alert is the source of truth; the
   * event is best-effort (a publish failure never blocks alerting).
   */
  private async raiseAlert(kind: AlertKind, platform: string, reason?: string): Promise<void> {
    await this.alerts.raise(kind, platform, reason);
    if (!this.eventBus) return;
    try {
      const type = kind === 'REFRESH_FAILURE' ? 'refresh_failed' : 'expiring';
      await this.eventBus.publish({
        topic: 'token_alert',
        type,
        payload: { platform, accountRef: platformSecretName(platform) },
      });
    } catch {
      // Non-critical; swallow.
    }
  }

  /** PlatformTokenProvider: usable token value for a platform, or undefined. */
  getTokenValue(platform: PlatformId): string | undefined {
    const value = this.secrets.optional(platformSecretName(platform));
    return isUsableTokenValue(value) ? value : undefined;
  }

  /** True when a usable token value is present in the Secret_Store. */
  private hasValue(platform: string): boolean {
    return isUsableTokenValue(this.secrets.optional(platformSecretName(platform)));
  }

  /**
   * Register/update token metadata (Req 10.1, 10.2). The raw `value` is never
   * written to the database — only its presence is reflected in `status`.
   */
  async register(
    platform: string,
    type: TokenType,
    value: string | undefined,
    expiresAt: Date | null,
  ): Promise<PublicTokenView> {
    const present = isUsableTokenValue(value);
    const status = present ? 'VALID' : 'MISSING';
    await this.prisma.platformToken.upsert({
      where: { platform },
      create: { platform, type, expiresAt, status },
      update: { type, expiresAt, status },
    });
    return this.toPublic({ platform, type, expiresAt, refreshWindowSeconds: 0 });
  }

  /** Secret-free list of all tokens with their computed validity (Req 10.3). */
  async listPublic(): Promise<PublicTokenView[]> {
    const rows = await this.prisma.platformToken.findMany({ orderBy: { platform: 'asc' } });
    return rows.map((r) =>
      this.toPublic({
        platform: r.platform,
        type: r.type,
        expiresAt: r.expiresAt,
        refreshWindowSeconds: r.refreshWindowSeconds,
      }),
    );
  }

  /** Validity predicate for a single platform (Req 10.5). */
  async isValid(platform: string): Promise<boolean> {
    const row = await this.prisma.platformToken.findUnique({ where: { platform } });
    return isTokenValid(this.hasValue(platform), row?.expiresAt ?? null, this.clock.now());
  }

  /**
   * Actively refresh a single platform's token (Req 11.2–11.4, 11.6).
   * On success updates the expiry; on failure retains the prior token and
   * records the reason. Always returns the secret-free public view.
   */
  async refresh(platform: string): Promise<PublicTokenView> {
    const { view } = await this.attemptRefresh(platform);
    return view;
  }

  /**
   * Scheduled refresh cycle (Req 11.1, 11.2, 11.7, 12.1, 12.2, 12.4).
   * Selects tokens whose expiry falls within their refresh window (skipping
   * non-expiring tokens), raises EXPIRY/PRE_EXPIRY_WARNING alerts, refreshes
   * each, and raises REFRESH_FAILURE when an exchange fails.
   */
  async runRefreshCycle(now: Date = this.clock.now()): Promise<PublicTokenView[]> {
    const rows = await this.prisma.platformToken.findMany();
    const results: PublicTokenView[] = [];

    for (const row of rows) {
      if (row.expiresAt === null) continue; // skip non-expiring tokens (Req 11.7)
      const msUntilExpiry = row.expiresAt.getTime() - now.getTime();
      const withinWindow = msUntilExpiry <= row.refreshWindowSeconds * 1000;
      if (!withinWindow) continue;

      // Req 12.1/12.2: alert before attempting refresh.
      if (row.expiresAt.getTime() <= now.getTime()) {
        await this.raiseAlert('EXPIRY', row.platform);
      } else {
        await this.raiseAlert('PRE_EXPIRY_WARNING', row.platform);
      }

      const { ok, reason, view } = await this.attemptRefresh(row.platform, now);
      if (!ok) {
        await this.raiseAlert('REFRESH_FAILURE', row.platform, reason); // Req 12.4
      }
      results.push(view);
    }
    return results;
  }

  // --- internals -------------------------------------------------------------

  private async attemptRefresh(
    platform: string,
    now: Date = this.clock.now(),
  ): Promise<{ ok: boolean; reason?: string; view: PublicTokenView }> {
    const existing = await this.prisma.platformToken.findUnique({ where: { platform } });
    const currentExpiry = existing?.expiresAt ?? null;
    const type = existing?.type ?? 'access_token';
    const window = existing?.refreshWindowSeconds ?? 0;

    try {
      await this.refresher.exchange(platform, now);
      const newExpiry = computeRefreshedExpiry(platform, now, currentExpiry);
      await this.prisma.platformToken.upsert({
        where: { platform },
        create: { platform, type, expiresAt: newExpiry, status: 'VALID' },
        update: { expiresAt: newExpiry, status: 'VALID', lastRefreshFailureReason: null },
      });
      return {
        ok: true,
        view: this.toPublic({ platform, type, expiresAt: newExpiry, refreshWindowSeconds: window }),
      };
    } catch (err) {
      // Req 11.6: retain the prior token; record the failure reason (secret-free).
      const reason = this.secrets.redact(err instanceof Error ? err.message : 'refresh failed');
      await this.prisma.platformToken.upsert({
        where: { platform },
        create: { platform, type, expiresAt: currentExpiry, status: 'REFRESH_FAILED', lastRefreshFailureReason: reason },
        update: { status: 'REFRESH_FAILED', lastRefreshFailureReason: reason },
      });
      return {
        ok: false,
        reason,
        view: this.toPublic({ platform, type, expiresAt: currentExpiry, refreshWindowSeconds: window }),
      };
    }
  }

  private toPublic(row: TokenRow): PublicTokenView {
    return {
      platform: row.platform,
      type: row.type,
      expiresAt: row.expiresAt,
      valid: isTokenValid(this.hasValue(row.platform), row.expiresAt, this.clock.now()),
    };
  }
}
