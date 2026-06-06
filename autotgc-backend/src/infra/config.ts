/**
 * Application configuration assembled from the SecretLoader.
 * Fail-fast on missing required secrets (Req 13.3); root-execution guard (Req 14.3).
 */
import type { SecretLoader } from './secrets';
import { firstMissingSecret } from './secrets';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  accessTokenTtlHours: number;
  refreshTokenTtlDays: number;
  lockoutThreshold: number;
  /** Auto-recovery window (minutes) for a locked account; 0 disables auto-unlock. */
  lockoutCooldownMinutes: number;
  frontendOrigin: string;
  webhookSecrets: Record<string, string>;
  syncStalenessHours: number;
  /** Trust X-Forwarded-* from a fronting proxy (nginx). */
  trustProxy: boolean;
  /**
   * Which responsibilities THIS process runs:
   *  - 'all'     : API + queue workers + cron (single-process; default, back-compat).
   *  - 'api'     : ONLY the HTTP API (no workers, no cron) — keeps the event loop
   *                free for requests/streaming.
   *  - 'worker'  : ONLY background work (queue workers + cron); does NOT listen.
   */
  runMode: 'all' | 'api' | 'worker';
  /** Facebook Messenger webhook subscription verify token (optional). */
  intakeFacebookVerifyToken: string;
}

const REQUIRED_SECRETS = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'];

/**
 * Parse RUN_MODE into the allowed set. Anything unset/unknown maps to 'all' so
 * the historic single-process behavior is preserved by default.
 */
export function parseRunMode(value: string | undefined): 'all' | 'api' | 'worker' {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'api') return 'api';
  if (v === 'worker') return 'worker';
  return 'all';
}

export function assertNotRoot(getUid?: () => number): void {
  // Req 14.3: refuse to start as root (POSIX only; getuid is undefined on Windows).
  const uid = getUid ?? (process.getuid?.bind(process));
  if (typeof uid === 'function') {
    if (uid() === 0) {
      // Do not begin serving requests.
      throw new Error('Refusing to start as root user. Run as a least-privilege application user.');
    }
  }
}

export function loadConfig(loader: SecretLoader): AppConfig {
  const missing = firstMissingSecret(loader, REQUIRED_SECRETS);
  if (missing) {
    throw new Error(`Startup aborted: required secret "${missing}" is absent from the secret store.`);
  }

  return {
    nodeEnv: loader.optional('NODE_ENV') ?? 'development',
    port: Number(loader.optional('PORT') ?? '3000'),
    host: loader.optional('HOST') ?? '127.0.0.1',
    databaseUrl: loader.require('DATABASE_URL'),
    redisUrl: loader.require('REDIS_URL'),
    jwtSecret: loader.require('JWT_SECRET'),
    accessTokenTtlHours: Number(loader.optional('ACCESS_TOKEN_TTL_HOURS') ?? '24'),
    refreshTokenTtlDays: Number(loader.optional('REFRESH_TOKEN_TTL_DAYS') ?? '30'),
    lockoutThreshold: Number(loader.optional('LOCKOUT_THRESHOLD') ?? '5'),
    lockoutCooldownMinutes: Number(loader.optional('LOCKOUT_COOLDOWN_MINUTES') ?? '15'),
    frontendOrigin: loader.optional('FRONTEND_ORIGIN') ?? '*',
    webhookSecrets: {
      facebook: loader.optional('WEBHOOK_SECRET_FACEBOOK') ?? '',
      website: loader.optional('WEBHOOK_SECRET_WEBSITE') ?? '',
      zalo: loader.optional('WEBHOOK_SECRET_ZALO') ?? '',
    },
    syncStalenessHours: Number(loader.optional('SYNC_STALENESS_HOURS') ?? '6'),
    // Default ON: production runs behind nginx. Set TRUST_PROXY=false only when
    // the app is directly internet-exposed (otherwise clients could spoof
    // X-Forwarded-For to evade per-IP rate limiting).
    trustProxy: (loader.optional('TRUST_PROXY') ?? 'true').trim().toLowerCase() !== 'false',
    runMode: parseRunMode(loader.optional('RUN_MODE')),
    intakeFacebookVerifyToken: loader.optional('INTAKE_FB_VERIFY_TOKEN') ?? '',
  };
}
