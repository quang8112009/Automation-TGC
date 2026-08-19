/**
 * Integration tests for the SSE streaming generation route, which previously had
 * NO route-level coverage:
 *
 *   POST /api/v1/generation/multi-format/stream
 *     requireAuth + rbacGuard(generation/create) -> ADMIN only.
 *
 * The behaviour under test:
 *  - 401 with no/invalid token (preHandler) — reply NOT hijacked.
 *  - 403 for SALES (generation is ADMIN-only) — reply NOT hijacked.
 *  - 400 for invalid input arrives as the NORMAL { error } envelope, because
 *    validation runs BEFORE reply.hijack() switches to SSE.
 *  - 200 happy path streams `delta` frames then a terminal `done` frame whose
 *    data carries the persisted draft — using a mocked streaming generator
 *    (NO network, NO real provider).
 *  - An AI failure AFTER the stream starts is delivered as an SSE `error` frame
 *    (still HTTP 200, since the response was already hijacked).
 *
 * Deterministic: fixed JWT secret, in-process tokens, in-memory Prisma fake,
 * and a mocked ContentGenerator. Mirrors the harness in aiTelemetryRoutes.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { registerMultiFormatRoutes } from '../src/marketing/content/routes';
import type { ContentGenerator, GenerateOptions } from '../src/strategy/personaService';
import { JwtService } from '../src/auth/jwt';
import { toErrorBody, AppError } from '../src/infra/errors';

const JWT_SECRET = 'stream-route-test-secret-deterministic-0123456789';
const jwt = new JwtService(JWT_SECRET, 24, 30);

const ADMIN = { userId: 'admin-1', role: 'ADMIN' as const, sessionId: 's-admin' };
const SALES = { userId: 'sales-1', role: 'SALES' as const, sessionId: 's-sales' };

const CANNED = JSON.stringify({ title: 'Tieu de', body: 'Noi dung day du.', ctas: ['Dang ky'] });

/** Streaming generator double: emits two deltas then returns the full text. */
class StreamingGemini implements ContentGenerator {
  async generateContent(): Promise<string> {
    return CANNED;
  }
  async streamContent(
    _prompt: string,
    onDelta: (chunk: string) => void,
    _options?: GenerateOptions,
  ): Promise<string> {
    onDelta('Noi dung ');
    onDelta('day du.');
    return CANNED;
  }
}

/** Generator that fails once streaming begins (post-hijack failure path). */
class FailingStreamGemini implements ContentGenerator {
  async generateContent(): Promise<string> {
    throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
  }
  async streamContent(): Promise<string> {
    throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
  }
}

function makePrismaFake(): PrismaClient {
  const sessions = new Map([
    [ADMIN.sessionId, { sessionId: ADMIN.sessionId, status: 'ACTIVE', revokedAt: null }],
    [SALES.sessionId, { sessionId: SALES.sessionId, status: 'ACTIVE', revokedAt: null }],
  ]);
  return {
    jwtSession: {
      findUnique: async (args: { where: { sessionId: string } }) =>
        sessions.get(args.where.sessionId) ?? null,
    },
    aiPromptContext: {
      findFirst: async () => null,
    },
    domainContext: {
      findUnique: async () => ({
        id: 'dom-1',
        domainName: 'XKLD Nhat Ban',
        contextDescription: 'Tu van.',
        defaultToneOfVoice: 'than thien',
      }),
    },
    contentPersona: {
      findMany: async () => [
        {
          id: 'per-1',
          personaName: 'Lao dong tre',
          age: '20-30',
          interests: 'thu nhap',
          targetNeeds: 'di lam',
          painPoints: 'chi phi',
          toneOfVoice: 'dong vien',
          recommendedTone: null,
          domainId: 'dom-1',
        },
      ],
    },
    contentDraft: {
      create: async (args: { data: Record<string, unknown> }) => ({
        id: 'draft-1',
        ...args.data,
        ctas: [{ id: 'cta-1', ctaText: 'Dang ky' }],
      }),
    },
  } as unknown as PrismaClient;
}

async function buildApp(gemini: ContentGenerator): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _request, reply) => {
    const { status, body } = toErrorBody(err, (s) => s);
    reply.code(status).send(body);
  });
  registerMultiFormatRoutes(app, { prisma: makePrismaFake(), jwt, gemini });
  await app.ready();
  return app;
}

const VALID_BODY = {
  format: 'FANPAGE_CAPTION',
  domainName: 'XKLD Nhat Ban',
  personaIds: ['per-1'],
  objective: 'View',
  market: 'JAPAN',
};

const URL = '/api/v1/generation/multi-format/stream';

let app: FastifyInstance;
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /multi-format/stream — auth/RBAC gating (pre-hijack)', () => {
  it('401 with no Authorization header', async () => {
    app = await buildApp(new StreamingGemini());
    const res = await app.inject({ method: 'POST', url: URL, payload: VALID_BODY });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('403 for a SALES token (generation is ADMIN-only)', async () => {
    app = await buildApp(new StreamingGemini());
    const token = await jwt.issueAccess(SALES.userId, SALES.role, SALES.sessionId);
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${token}` },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});

describe('POST /multi-format/stream — validation runs before hijack', () => {
  it('400 invalid format returns the normal { error } envelope (not an SSE frame)', async () => {
    app = await buildApp(new StreamingGemini());
    const token = await jwt.issueAccess(ADMIN.userId, ADMIN.role, ADMIN.sessionId);
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { ...VALID_BODY, format: 'NOPE' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    // Zod validation catches invalid format before business logic (VALIDATION_ERROR)
    // or the business layer catches it (GEN_FORMAT_INVALID). Both are valid 400s.
    expect(['VALIDATION_ERROR', 'GEN_FORMAT_INVALID']).toContain(body.error.code);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
  });
});

describe('POST /multi-format/stream — SSE happy path (ADMIN)', () => {
  it('streams delta frames then a terminal done frame carrying the draft', async () => {
    app = await buildApp(new StreamingGemini());
    const token = await jwt.issueAccess(ADMIN.userId, ADMIN.role, ADMIN.sessionId);
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${token}` },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const payload = res.payload;
    // Both deltas were forwarded as SSE `delta` frames.
    expect(payload).toContain('event: delta');
    expect(payload).toContain(JSON.stringify({ text: 'Noi dung ' }));
    expect(payload).toContain(JSON.stringify({ text: 'day du.' }));
    // A terminal `done` frame with the persisted draft.
    expect(payload).toContain('event: done');
    expect(payload).toContain('"format":"FANPAGE_CAPTION"');
    expect(payload).not.toContain('event: error');
  });
});

describe('POST /multi-format/stream — post-hijack failure path', () => {
  it('delivers a mid-stream AI failure as an SSE error frame (HTTP 200)', async () => {
    app = await buildApp(new FailingStreamGemini());
    const token = await jwt.issueAccess(ADMIN.userId, ADMIN.role, ADMIN.sessionId);
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${token}` },
      payload: VALID_BODY,
    });

    // Already hijacked into SSE, so the transport status is 200 and the failure
    // is an `error` frame rather than an envelope.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('event: error');
    expect(res.payload).toContain('AI_REQUEST_FAILED');
  });
});
