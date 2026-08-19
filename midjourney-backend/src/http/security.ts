/**
 * Production security hardening: HTTP security headers (@fastify/helmet) and
 * request rate limiting (@fastify/rate-limit).
 *
 * Notes on status codes: the project's allowed-status set (infra/errors.ts) does
 * NOT include 429. Rate limiting therefore returns 429 directly through the
 * plugin's own `errorResponseBuilder` (it never reaches our global error handler),
 * which is the conventional behaviour for rate limiting and is acceptable here.
 *
 * Resilience: when a Redis URL is supplied we use a Redis-backed store so limits
 * are shared across instances; if Redis is unavailable we fall back to the
 * in-memory store and `skipOnError` keeps the API serving rather than throwing.
 */
import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { getRedis } from '../infra/redis';

/**
 * Stricter limit intended for auth endpoints (`/api/auth/login`,
 * `/api/auth/register`). The caller applies it per-route, e.g.
 *   app.post('/api/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, handler)
 */
export interface RateLimitConfig {
  max: number;
  timeWindow: string;
}

export const AUTH_RATE_LIMIT: RateLimitConfig = {
  max: 10,
  timeWindow: '1 minute',
};

/**
 * Stricter limit for cost-heavy AI assistant endpoints (ask / ask-stream /
 * knowledge-reindex). Each request can trigger embedding + multi-round LLM
 * calls, so cap per-IP throughput to blunt cost-DoS while staying generous for
 * normal interactive use. Applied per-route via `config: { rateLimit: ... }`.
 */
export const ASSISTANT_RATE_LIMIT: RateLimitConfig = {
  max: 20,
  timeWindow: '1 minute',
};

/** Default global ceiling applied to every route unless overridden per-route. */
export const GLOBAL_RATE_LIMIT: RateLimitConfig = {
  max: 300,
  timeWindow: '1 minute',
};

export interface SecurityOptions {
  /** When provided, rate-limit counters are stored in Redis; otherwise in-memory. */
  rateLimitRedisUrl?: string;
}

export async function registerSecurity(
  app: FastifyInstance,
  opts: SecurityOptions = {},
): Promise<void> {
  // --- Security headers ----------------------------------------------------
  // CSP is disabled because this service only emits JSON (no HTML/asset origin
  // to constrain); all other helmet protections remain enabled.
  // Additional hardening: strict HSTS, no sniffing, frame deny, referrer policy.
  if (!app.hasReplyDecorator('helmet')) {
    await app.register(helmet, {
      contentSecurityPolicy: false,
      // HSTS: 1 year, include subdomains, preload-ready.
      strictTransportSecurity: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      // Prevent MIME-type sniffing.
      noSniff: true,
      // X-Frame-Options: DENY (this API serves JSON, never HTML).
      frameguard: { action: 'deny' },
      // Referrer: no origin leaked to third parties.
      referrerPolicy: { policy: 'no-referrer' },
      // Hide X-Powered-By.
      hidePoweredBy: true,
      // XSS Protection (legacy browsers).
      xssFilter: true,
      // Note: permissionsPolicy is not available in @fastify/helmet v11.x.
      // When upgrading to helmet v14+, add:
      // permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
    });
  }

  // --- Rate limiting -------------------------------------------------------
  if (!app.hasDecorator('rateLimit')) {
    let redisClient: ReturnType<typeof getRedis> | undefined;
    if (opts.rateLimitRedisUrl) {
      try {
        redisClient = getRedis(opts.rateLimitRedisUrl);
      } catch {
        // Redis construction failed -> fall back to the in-memory store.
        redisClient = undefined;
      }
    }

    await app.register(rateLimit, {
      global: true,
      max: GLOBAL_RATE_LIMIT.max,
      timeWindow: GLOBAL_RATE_LIMIT.timeWindow,
      redis: redisClient,
      // Fail open if the backing store errors at request time (e.g. Redis down)
      // so a transient cache outage cannot take the whole API offline.
      skipOnError: true,
      // Use the plugin's built-in 429 response (sent directly, bypassing the
      // global error handler). 429 is intentionally outside our AppError status
      // set; rate limiting is the one conventional exception.
    });
  }
}
