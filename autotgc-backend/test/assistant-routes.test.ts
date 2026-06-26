/**
 * Integration tests for the grounded-assistant routes
 * (`src/infra/assistantRoutes.ts`): conversational MEMORY + SSE STREAMING.
 *
 *  - auth/RBAC gating (401 unauth; ADMIN+SALES may use the assistant).
 *  - conversation create/list/messages are owner-scoped (foreign id → 404).
 *  - POST /ask with conversationId persists the user+assistant turn and feeds
 *    history back (memory).
 *  - POST /ask/stream emits `delta` then a terminal `done`; with no streamer it
 *    streams the deterministic grounded fallback (aiGenerated:false).
 *
 * Deterministic: fixed JWT secret, in-process tokens, in-memory Prisma fake, no
 * network/provider. Mirrors the harness in multi-format-stream-route.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { registerAssistantRoutes, type TextStreamer } from '../src/infra/assistantRoutes';
import { JwtService } from '../src/auth/jwt';
import { toErrorBody } from '../src/infra/errors';

const JWT_SECRET = 'assistant-route-test-secret-deterministic-0123456789';
const jwt = new JwtService(JWT_SECRET, 24, 30);

const ADMIN = { userId: 'admin-1', role: 'ADMIN' as const, sessionId: 's-admin' };
const SALES = { userId: 'sales-1', role: 'SALES' as const, sessionId: 's-sales' };

/** A streamer double that emits two deltas then returns the full text. */
const fakeStreamer: TextStreamer = {
  async streamContent(_prompt, onDelta) {
    onDelta('Xin ');
    onDelta('chao.');
    return 'Xin chao.';
  },
};

interface ConvRow { id: string; userId: string; title: string | null; createdAt: Date; updatedAt: Date }
interface MsgRow { id: string; conversationId: string; role: 'USER' | 'ASSISTANT'; content: string; aiGenerated: boolean; createdAt: Date }

function makePrismaFake(): PrismaClient {
  const sessions = new Map([
    [ADMIN.sessionId, { sessionId: ADMIN.sessionId, status: 'ACTIVE', revokedAt: null }],
    [SALES.sessionId, { sessionId: SALES.sessionId, status: 'ACTIVE', revokedAt: null }],
  ]);
  const convs: ConvRow[] = [];
  const msgs: MsgRow[] = [];
  let seq = 0;
  const now = (): Date => new Date(Date.now() + seq++);

  return {
    jwtSession: {
      findUnique: async (args: { where: { sessionId: string } }) => sessions.get(args.where.sessionId) ?? null,
    },
    knowledgeEntry: {
      // Retriever keyword path loads active rows; an empty KB → deterministic
      // "no grounding" fallback (still a valid answer).
      findMany: async () => [],
    },
    assistantConversation: {
      create: async ({ data }: { data: { userId: string; title: string | null } }) => {
        const row: ConvRow = { id: `c${convs.length + 1}`, userId: data.userId, title: data.title, createdAt: now(), updatedAt: now() };
        convs.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { userId: string } }) =>
        convs.filter((c) => c.userId === where.userId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        convs.find((c) => c.id === where.id && c.userId === where.userId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { updatedAt: Date } }) => {
        const row = convs.find((c) => c.id === where.id);
        if (row) row.updatedAt = data.updatedAt;
        return row;
      },
    },
    assistantMessage: {
      create: async ({ data }: { data: Omit<MsgRow, 'id' | 'createdAt'> }) => {
        const row: MsgRow = { id: `m${msgs.length + 1}`, createdAt: now(), ...data };
        msgs.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take }: { where: { conversationId: string }; orderBy: { createdAt: 'asc' | 'desc' }; take?: number }) => {
        const list = msgs
          .filter((m) => m.conversationId === where.conversationId)
          .sort((a, b) => (orderBy.createdAt === 'asc' ? a.createdAt.getTime() - b.createdAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime()));
        return take ? list.slice(0, take) : list;
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaClient;
}

async function buildApp(opts: { streamer?: TextStreamer } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _request, reply) => {
    const { status, body } = toErrorBody(err, (s) => s);
    reply.code(status).send(body);
  });
  await registerAssistantRoutes(app, { prisma: makePrismaFake(), jwt, streamer: opts.streamer });
  await app.ready();
  return app;
}

const bearer = async (p: typeof ADMIN | typeof SALES): Promise<string> =>
  `Bearer ${await jwt.issueAccess(p.userId, p.role, p.sessionId)}`;

let app: FastifyInstance;
afterEach(async () => {
  if (app) await app.close();
});

describe('assistant routes — auth gating', () => {
  it('401 without a token on /ask', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/assistant/ask', payload: { question: 'hi' } });
    expect(res.statusCode).toBe(401);
  });

  it('SALES may create a conversation (assistant is ADMIN+SALES)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/conversations',
      headers: { authorization: await bearer(SALES) },
      payload: { title: 'Hoi dap' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { id: string }).id).toBeTruthy();
  });
});

describe('assistant routes — conversation memory ownership', () => {
  it('a user cannot read another user\'s conversation messages (404)', async () => {
    app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/conversations',
      headers: { authorization: await bearer(ADMIN) },
      payload: {},
    });
    const id = (created.json() as { id: string }).id;

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/assistant/conversations/${id}/messages`,
      headers: { authorization: await bearer(SALES) },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('POST /ask with conversationId persists the turn (memory)', async () => {
    app = await buildApp();
    const auth = await bearer(ADMIN);
    const created = await app.inject({ method: 'POST', url: '/api/v1/assistant/conversations', headers: { authorization: auth }, payload: {} });
    const id = (created.json() as { id: string }).id;

    const ask = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/ask',
      headers: { authorization: auth },
      payload: { question: 'Cau hoi dau tien', conversationId: id },
    });
    expect(ask.statusCode).toBe(200);
    expect((ask.json() as { conversationId: string }).conversationId).toBe(id);

    const msgs = await app.inject({ method: 'GET', url: `/api/v1/assistant/conversations/${id}/messages`, headers: { authorization: auth } });
    const list = (msgs.json() as { messages: { role: string; content: string }[] }).messages;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ role: 'USER', content: 'Cau hoi dau tien' });
    expect(list[1].role).toBe('ASSISTANT');
  });
});

describe('assistant routes — SSE streaming', () => {
  it('streams delta frames then a terminal done frame (with a streamer)', async () => {
    app = await buildApp({ streamer: fakeStreamer });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/ask/stream',
      headers: { authorization: await bearer(ADMIN) },
      payload: { question: 'Xin chao?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('event: delta');
    expect(res.payload).toContain(JSON.stringify({ text: 'Xin ' }));
    expect(res.payload).toContain('event: done');
    expect(res.payload).toContain('"aiGenerated":true');
  });

  it('with NO streamer, streams the deterministic fallback (aiGenerated:false)', async () => {
    app = await buildApp(); // no streamer
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/ask/stream',
      headers: { authorization: await bearer(SALES) },
      payload: { question: 'Co thong tin gi khong?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('event: delta');
    expect(res.payload).toContain('event: done');
    expect(res.payload).toContain('"aiGenerated":false');
  });

  it('400 for a missing question arrives as a normal envelope (pre-hijack)', async () => {
    app = await buildApp({ streamer: fakeStreamer });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/ask/stream',
      headers: { authorization: await bearer(ADMIN) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    expect((res.json() as { error: { code: string } }).error.code).toBe('ASSISTANT_QUESTION_REQUIRED');
  });

  it('400 for an over-long question (cost-DoS guard)', async () => {
    app = await buildApp({ streamer: fakeStreamer });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/ask',
      headers: { authorization: await bearer(ADMIN) },
      payload: { question: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ASSISTANT_QUESTION_TOO_LONG');
  });
});
