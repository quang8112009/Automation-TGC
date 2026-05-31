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
  frontendOrigin: string;
  webhookSecrets: Record<string, string>;
  syncStalenessHours: number;
}

const REQUIRED_SECRETS = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'];

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
    frontendOrigin: loader.optional('FRONTEND_ORIGIN') ?? '*',
    webhookSecrets: {
      facebook: loader.optional('WEBHOOK_SECRET_FACEBOOK') ?? '',
      website: loader.optional('WEBHOOK_SECRET_WEBSITE') ?? '',
    },
    syncStalenessHours: Number(loader.optional('SYNC_STALENESS_HOURS') ?? '6'),
  };
}
