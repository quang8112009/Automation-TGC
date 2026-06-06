/**
 * Integration tests for the AgentOps telemetry read route (task: AgentOps).
 *
 *   GET /api/v1/ai/telemetry  -> requireAuth + rbacGuard(dashboard/company_stats)
 *                                ADMIN only; SALES -> 403; no/!invalid token -> 401.
 *
 * Unlike `reportingRoutes.test.ts` / `dashboard-rbac.regression.test.ts` — whose
 * FastifyInstance-double invokes handler BODIES directly and therefore skips the
 * requireAuth/rbacGuard preHandlers — this route's entire behaviour under test
 * (401/403/200 gating) lives in those preHandlers. So we take the real-token
 * path the harness leaves open: a real `fastify()` instance with the same global
 * AppError->envelope error handler as `app.ts`, the route registered via
 * `registerAiTelemetryRoutes`, real ADMIN/SALES access tokens minted by a real
 * `JwtService`, and an in-memory Prisma fake for the session lookup (the same
 * fake-Prisma + JwtService dep shape the reference tests construct). Requests
 * are driven through `app.inject` with the `Authorization` header set.
 *
 * Deterministic: fixed JWT secret, tokens minted in-process (no network, no real
 * provider), and a real `InMemoryAiTelemetrySink` we push records into before the
 * request. Only the allowed status codes (200/401/403) are asserted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { registerAiTelemetryRoutes } from '../src/infra/aiTelemetryRoutes';
import { InMemoryAiTelemetrySink } from '../src/infra/aiTelemetry';
import type { AiCallRecord } from '../src/infra/aiTelemetry';
import { JwtService } from '../src/auth/jwt';
import { toErrorBody } from '../src/infra/errors';

// ===========================================================================
// Harness: real JwtService + in-memory Prisma fake (jwtSession lookup only).
// ===========================================================================

const JWT_SECRET = 'test-only-jwt-secret-deterministic-0123456789';
const jwt = new JwtService(JWT_SECRET, 24, 30);

const ADMIN = { userId: 'admin-1', role: 'ADMIN' as const, sessionId: 's-admin' };
const SALES = { userId: 'sales-1', role: 'SALES' as const, sessionId: 's-sales' };

/**
 * In-memory Prisma fake covering exactly the read `requireAuth` performs:
 * `jwtSession.findUnique({ where: { sessionId } })`. The two sessions we mint
 * tokens for are seeded ACTIVE; anything else resolves to null (so a forged
 * session id would be rejected just like production).
 */
function makePrismaFake(): PrismaClient {
  const sessions = new Map<string, { sessionId: string; status: string; revokedAt: Date | null }>([
    [ADMIN.sessionId, { sessionId: ADMIN.sessionId, status: 'ACTIVE', revokedAt: null }],
    [SALES.sessionId, { sessionId: SALES.sessionId, status: 'ACTIVE', revokedAt: null }],
  ]);

  return {
    jwtSession: {
      findUnique: async (args: { where: { sessionId: string } }) =>
        sessions.get(args.where.sessionId) ?? null,
    },
  } as unknown as PrismaClient;
}

/**
 * Build a real Fastify instance wired exactly like `app.ts` for error handling:
 * thrown AppError -> { error: { code, message } } envelope with its allowed
 * status. The route is registered against the supplied sink so a test can push
 * records before issuing the request.
 */
async function buildApp(sink: InMemoryAiTelemetrySink): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _request, reply) => {
    const { status, body } = toErrorBody(err, (s) => s);
    reply.code(status).send(body);
  });
  await registerAiTelemetryRoutes(app, { prisma: makePrismaFake(), jwt, aiTelemetry: sink });
  await app.ready();
  return app;
}

function record(over: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    model: over.model ?? 'deepseek-v4-flash',
    latencyMs: over.latencyMs ?? 100,
    outcome: over.outcome ?? 'SUCCESS',
    errorCode: over.errorCode,
    promptChars: over.promptChars ?? 10,
    startedAt: over.startedAt ?? 1,
  };
}

const SUMMARY_FIELDS = [
  'totalCalls',
  'successCount',
  'aiErrorCount',
  'unknownErrorCount',
  'errorRate',
  'successRate',
  'p50LatencyMs',
  'p95LatencyMs',
  'errorCodeCounts',
] as const;

let app: FastifyInstance;
let sink: InMemoryAiTelemetrySink;

beforeEach(() => {
  sink = new InMemoryAiTelemetrySink();
});

afterEach(async () => {
  if (app) await app.close();
});

// ===========================================================================
// 1. No / invalid Authorization -> 401
// ===========================================================================

describe('GET /api/v1/ai/telemetry — authentication (401)', () => {
  it('rejects a request with no Authorization header (401)', async () => {
    app = await buildApp(sink);

    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/telemetry' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  it('rejects a malformed Authorization header (401)', async () => {
    app = await buildApp(sink);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/telemetry',
      headers: { authorization: 'Basic not-a-bearer-token' },
    });

    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an invalid/forged bearer token (401)', async () => {
    app = await buildApp(sink);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/telemetry',
      headers: { authorization: 'Bearer not.a.valid.jwt' },
    });

    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});

// ===========================================================================
// 2. SALES token -> 403 (company_stats is ADMIN-only)
// ===========================================================================

describe('GET /api/v1/ai/telemetry — RBAC (403)', () => {
  it('denies SALES with a 403 (dashboard/company_stats is ADMIN-only)', async () => {
    app = await buildApp(sink);
    const token = await jwt.issueAccess(SALES.userId, SALES.role, SALES.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/telemetry',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: { code: 'FORBIDDEN', message: expect.any(String) },
    });
  });
});

// ===========================================================================
// 3. ADMIN token -> 200 with the aggregated summary shape (empty sink).
// ===========================================================================

describe('GET /api/v1/ai/telemetry — ADMIN summary (200)', () => {
  it('returns the INSUFFICIENT_DATA summary for an empty sink', async () => {
    app = await buildApp(sink);
    const token = await jwt.issueAccess(ADMIN.userId, ADMIN.role, ADMIN.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/telemetry',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // Full aggregated summary shape is present.
    expect(Object.keys(body).sort()).toEqual([...SUMMARY_FIELDS].sort());

    // Empty sink -> counts 0, rates/percentiles INSUFFICIENT_DATA (numeric-safe).
    expect(body).toEqual({
      totalCalls: 0,
      successCount: 0,
      aiErrorCount: 0,
      unknownErrorCount: 0,
      errorRate: 'INSUFFICIENT_DATA',
      successRate: 'INSUFFICIENT_DATA',
      p50LatencyMs: 'INSUFFICIENT_DATA',
      p95LatencyMs: 'INSUFFICIENT_DATA',
      errorCodeCounts: {},
    });
  });
});

// ===========================================================================
// 4. After recording records, ADMIN GET reflects them.
// ===========================================================================

describe('GET /api/v1/ai/telemetry — reflects recorded telemetry (200)', () => {
  it('aggregates the records pushed into the injected sink', async () => {
    // Two successes, one typed AI error, one unknown error -> N = 4.
    sink.record(record({ latencyMs: 100, outcome: 'SUCCESS' }));
    sink.record(record({ latencyMs: 200, outcome: 'SUCCESS' }));
    sink.record(record({ latencyMs: 300, outcome: 'AI_ERROR', errorCode: 'AI_REQUEST_FAILED' }));
    sink.record(record({ latencyMs: 400, outcome: 'UNKNOWN_ERROR' }));

    app = await buildApp(sink);
    const token = await jwt.issueAccess(ADMIN.userId, ADMIN.role, ADMIN.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/telemetry',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body.totalCalls).toBe(4);
    expect(body.successCount).toBe(2);
    expect(body.aiErrorCount).toBe(1);
    expect(body.unknownErrorCount).toBe(1);
    // 2 errors of 4 calls -> 0.5; 2 successes of 4 -> 0.5.
    expect(body.errorRate).toBe(0.5);
    expect(body.successRate).toBe(0.5);
    // Typed AI error code is counted; unknown error contributes no code.
    expect(body.errorCodeCounts).toEqual({ AI_REQUEST_FAILED: 1 });
    // Percentiles are real numbers now that latencies exist.
    expect(typeof body.p50LatencyMs).toBe('number');
    expect(typeof body.p95LatencyMs).toBe('number');

    // The response equals the pure aggregator over the same sink (no drift).
    expect(body).toEqual(sink.summary());
  });
});
