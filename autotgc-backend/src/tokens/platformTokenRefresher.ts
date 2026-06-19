/**
 * Production TokenRefresher wiring.
 *
 * The TokenManager refresh cycle (`runRefreshCycle`) calls `refresher.exchange()`
 * for every platform token that falls inside its refresh window. The contract is:
 *   - exchange() RESOLVES  -> the cycle treats it as a successful refresh and
 *                             advances the stored expiry (Facebook +60d, etc.).
 *   - exchange() THROWS    -> the cycle RETAINS the prior expiry, marks the row
 *                             REFRESH_FAILED, and raises a REFRESH_FAILURE alert.
 *
 * Historically this seam was wired to a no-op that RESOLVED while doing nothing —
 * so the cycle silently pushed the expiry forward (e.g. +60 days for Facebook)
 * even though NO real token exchange happened. That masks a genuinely-expiring
 * token: its metadata looks freshly-valid, the pre-expiry/expiry alerts stop
 * firing, and an admin is never told to act — until publishing/analytics calls
 * start failing in production (directly hurting reach + lead conversion).
 *
 * Until a real per-platform token exchange is configured (which additionally
 * requires a writable place to persist the rotated token VALUE — by design the
 * Secret_Store keeps values OUT of the database), the honest behaviour is to
 * FAIL the auto-refresh so the existing alerting surfaces it. Operators then
 * refresh the credential out-of-band (rotate the platform token + redeploy/secret
 * update), or, preferably, use a non-expiring credential (e.g. a Facebook
 * Business "System User" token) so the token never enters the refresh window at
 * all and the cycle skips it (Req 11.7).
 */
import type { TokenRefresher } from './tokenManager';

/** Thrown by the manual-mode refresher; message is safe to log (no secrets). */
export class TokenRefreshNotConfiguredError extends Error {
  constructor(platform: string) {
    super(
      `Automatic token exchange is not configured for platform "${platform}". ` +
        `Refresh the platform token manually (or provision a non-expiring credential) — ` +
        `the cycle will not silently extend its expiry.`,
    );
    this.name = 'TokenRefreshNotConfiguredError';
  }
}

/**
 * Manual-mode refresher: no automatic exchange is wired, so every refresh attempt
 * fails honestly. This makes `runRefreshCycle` RETAIN the real expiry and raise a
 * REFRESH_FAILURE alert for any token inside its refresh window, instead of
 * masking it by optimistically bumping the expiry. Non-expiring tokens
 * (expiresAt = null) are skipped by the cycle and never reach this code.
 */
export function createManualModeRefresher(): TokenRefresher {
  return {
    async exchange(platform: string): Promise<void> {
      throw new TokenRefreshNotConfiguredError(platform);
    },
  };
}
