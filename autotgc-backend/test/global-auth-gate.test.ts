/**
 * Tests for the GLOBAL AUTH GATE (deny-by-default) added in `app.ts` via
 * `registerGlobalAuthGate` (src/http/authMiddleware.ts).
 *
 * Two layers:
 *  1. Pure `isPublicPath` allow-list matching (exact match + the /docs prefix,
 *     query-string stripping, trailing-slash tolerance). This is the security-
 *     critical predicate that decides whether a request skips authentication.
 *  2. An integration smoke test on a real `fastify()` instance with the gate
 *     installed: a protected route returns 401 without a token, the same route
 *     succeeds with a valid ACTIVE-session token, and a public route is reachable
 *     with no token at all.
 *
 * Deterministic: fixed JWT secret, in-process tokens, in-memory Prisma fake for
 * the session lookup. Mirrors the harness shape of `aiTelemetryRoutes.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';

import {
  isPublicPath,
  registerGlobalAuthGate,
  PUBLIC_PATHS,
} from '../src/http/authMiddleware';
import { JwtService } from '../src/auth/jwt';
import { toErrorBody } from '../src/infra/errors';

const JWT_SECRET = 'test-only-jwt-secret-deterministic-0123456789';
const jwt = new JwtService(JWT_SECRET, 24, 30);

const ACTIVE_SESSION = 's-active';

function makePrismaFake(): PrismaClient {
  const sessions = new Map([
    [ACTIVE_SESSION, { sessionId: ACTIVE_SESSION, status: 'ACTIVE', revokedAt: null as Date | null }],
  ]);
  return {
    jwtSession: {
      findUnique: async (args: { where: { sessionId: string } }) =>
        sessions.get(args.where.sessionId) ?? null,
    },
  } as unknown as PrismaClient;
}

describe('isPublicPath (allow-list matching)', () => {
  it('matches every declared public path exactly', () => {
    for (const p of PUBLIC_PATHS) {
      expect(isPublicPath(p)).toBe(true);
    }
  });

  it('strips the query string before matching', () => {
    expect(isPublicPath('/healthz?probe=1')).toBe(true);
    expect(isPublicPath('/api/auth/login?next=%2F')).toBe(true);
  });

  it('tolerates a trailing slash on an allow-listed path', () => {
    expect(isPublicPath('/api/auth/refresh/')).toBe(true);
  });

  it('prefix-matches ONLY the /docs UI assets', () => {
    expect(isPublicPath('/docs')).toBe(true);
    expect(isPublicPath('/docs/')).toBe(true);
    expect(isPublicPath('/docs/json')).toBe(true);
    expect(isPublicPath('/docs/static/index.html')).toBe(true);
  });

  it('does NOT treat a protected route as public', () => {
    expect(isPublicPath('/api/leads')).toBe(false);
    expect(isPublicPath('/api/v1/candidates')).toBe(false);
    expect(isPublicPath('/api/dashboard/overview')).toBe(false);
    // A path that merely starts with a public path string must NOT leak through
    // (exact match only, except /docs/*).
    expect(isPublicPath('/healthz-internal')).toBe(false);
    expect(isPublicPath('/api/auth/login-as-admin')).toBe(false);
  });
});

describe('registerGlobalAuthGate (deny-by-default integration)', () => {
  async function buildGated() {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      const { status, body } = toErrorBody(err, (s) => s);
      reply.code(status).send(body);
    });
    registerGlobalAuthGate(app, { prisma: makePrismaFake(), jwt });
    app.get('/healthz', async () => ({ status: 'ok' }));
    app.get('/api/protected', async (req) => ({ userId: req.auth?.userId ?? null }));
    await app.ready();
    return app;
  }

  it('rejects a protected route with 401 when no token is supplied', async () => {
    const app = await buildGated();
    const res = await app.inject({ method: 'GET', url: '/api/protected' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a protected route with 401 for a forged/unknown session', async () => {
    const app = await buildGated();
    const token = await jwt.issueAccess('u1', 'ADMIN', 'no-such-session');
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('allows a protected route with a valid ACTIVE-session token', async () => {
    const app = await buildGated();
    const token = await jwt.issueAccess('u1', 'ADMIN', ACTIVE_SESSION);
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'u1' });
    await app.close();
  });

  it('allows a public route with no token at all', async () => {
    const app = await buildGated();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
