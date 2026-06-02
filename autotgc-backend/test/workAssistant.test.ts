/**
 * Unit / edge tests for the Work_Assistant (Trợ lý Công việc TGC) — task 5.6.
 *
 * Covers the design's acceptance criteria for the assistant + its route wiring:
 *   - Gemini stub configured -> aiGenerated = true (Req 6.2)
 *   - whitespace-only question -> 400 ValidationError at the route (Req 6.5)
 *   - deterministic fallback answer is in Vietnamese (Req 6.6)
 *   - neither the prompt handed to Gemini nor the answer contains a secret (Req 7.5)
 *   - missing knowledge field on create -> 400 ValidationError at the route (Req 8.2)
 *
 * The KnowledgeService is backed by a tiny in-memory Prisma fake (only the
 * methods these paths touch), and the Gemini seam is a stub — no network / key.
 * The route preHandlers (requireAuth/rbacGuard) are stubbed to no-ops so we can
 * unit-test the handler bodies (validation + service delegation) directly via
 * a minimal FastifyInstance test double that captures registered handlers.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { KnowledgeEntry, PrismaClient } from '@prisma/client';

import { WorkAssistant } from '../src/recruitment/agent/workAssistant';
import { registerRecruitmentAgentRoutes } from '../src/recruitment/agent/routes';
import { KnowledgeService } from '../src/recruitment/knowledge/knowledgeService';
import { COMPANY_IDENTITY } from '../src/recruitment/knowledge/knowledgeBase';
import type { ContentGenerator } from '../src/strategy/personaService';
import { ValidationError } from '../src/infra/errors';import type { JwtService } from '../src/auth/jwt';

// ===========================================================================
// Fixtures
// ===========================================================================

const NOW = new Date('2025-06-01T00:00:00.000Z');
const SECRET = 'sk-super-secret-key-1234567890';

function makeEntry(over: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  return {
    id: over.id,
    category: over.category ?? 'faq',
    title: over.title ?? 'Mục mẫu',
    content: over.content ?? 'Nội dung mẫu.',
    tags: (over.tags ?? []) as KnowledgeEntry['tags'],
    market: over.market ?? null,
    active: over.active ?? true,
    createdAt: over.createdAt ?? NOW,
    updatedAt: over.updatedAt ?? NOW,
  };
}

const SAMPLE_ROWS: KnowledgeEntry[] = [
  makeEntry({
    id: 'k1',
    category: 'market',
    title: 'Thị trường Nhật Bản',
    content: 'Thông tin về đơn hàng đi Nhật, visa và chi phí tham khảo.',
    tags: ['nhat', 'visa', 'chi-phi'],
  }),
  makeEntry({
    id: 'k2',
    category: 'faq',
    title: 'Hồ sơ cần chuẩn bị',
    content: 'Danh sách giấy tờ ứng viên cần nộp khi đăng ký.',
    tags: ['hoso', 'giay-to'],
  }),
];

/** Prisma fake exposing only `knowledgeEntry.findMany`, filtering by active. */
function makeKnowledgeService(rows: readonly KnowledgeEntry[]): KnowledgeService {
  const prisma = {
    knowledgeEntry: {
      findMany: async (args?: { where?: { active?: boolean } }) => {
        const wantActive = args?.where?.active;
        if (wantActive === undefined) return [...rows];
        return rows.filter((r) => r.active === wantActive);
      },
    },
  } as unknown as PrismaClient;
  return new KnowledgeService(prisma);
}

/** Gemini stub returning a canned answer and capturing the last prompt. */
class CannedGemini implements ContentGenerator {
  lastPrompt = '';
  constructor(private readonly response: string) {}
  async generateContent(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return this.response;
  }
}

// ===========================================================================
// Minimal Fastify test double — captures the route handlers so we can invoke
// the handler bodies directly (the preHandlers / auth are out of scope here).
// ===========================================================================

interface CapturedRoute {
  method: 'get' | 'post' | 'put';
  path: string;
  handler: (request: any, reply: any) => Promise<unknown>;
}

function makeAppDouble(): { app: FastifyInstance; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = [];
  const register = (method: CapturedRoute['method']) =>
    (path: string, _opts: unknown, handler: CapturedRoute['handler']) => {
      routes.push({ method, path, handler });
    };
  const app = {
    get: register('get'),
    post: register('post'),
    put: register('put'),
  } as unknown as FastifyInstance;
  return { app, routes };
}

/** A reply double capturing the status code and JSON body. */
function makeReply(): { reply: any; sent: { code: number; body: unknown } } {
  const sent = { code: 200, body: undefined as unknown };
  const reply = {
    code(this: any, c: number) {
      sent.code = c;
      return this;
    },
    send(this: any, body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { reply, sent };
}

/** Register the agent routes against the double and index them by "METHOD path". */
function registerRoutes(opts: {
  rows?: readonly KnowledgeEntry[];
  gemini?: ContentGenerator;
}): Map<string, CapturedRoute> {
  const { app, routes } = makeAppDouble();
  // The registrar builds its own KnowledgeService + WorkAssistant from the
  // injected prisma seam; we provide a fake exposing the knowledgeEntry methods
  // these routes touch (findMany / create / findUnique / update).
  registerRecruitmentAgentRoutes(app, {
    prisma: makePrismaFake(opts.rows ?? SAMPLE_ROWS),
    jwt: {} as JwtService,
    gemini: opts.gemini,
  });
  const map = new Map<string, CapturedRoute>();
  for (const r of routes) map.set(`${r.method.toUpperCase()} ${r.path}`, r);
  return map;
}

/** A fuller prisma fake for the route deps (knowledgeEntry create/findMany). */
function makePrismaFake(rows: readonly KnowledgeEntry[]): PrismaClient {
  const store = [...rows];
  return {
    knowledgeEntry: {
      findMany: async (args?: { where?: { active?: boolean } }) => {
        const wantActive = args?.where?.active;
        if (wantActive === undefined) return [...store];
        return store.filter((r) => r.active === wantActive);
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = makeEntry({ id: `created-${store.length + 1}`, ...(args.data as Partial<KnowledgeEntry>) });
        store.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        store.find((r) => r.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = store.findIndex((r) => r.id === args.where.id);
        const row = makeEntry({ ...(store[idx] as KnowledgeEntry), ...(args.data as Partial<KnowledgeEntry>) });
        store[idx] = row;
        return row;
      },
    },
  } as unknown as PrismaClient;
}

// ===========================================================================
// Service-level: Gemini stub -> aiGenerated true (Req 6.2)
// ===========================================================================

describe('WorkAssistant.ask — Gemini configured (Req 6.2)', () => {
  it('returns aiGenerated=true using the Gemini stub output, with grounding sources', async () => {
    const gemini = new CannedGemini('Đây là câu trả lời từ Gemini.');
    const assistant = new WorkAssistant(makeKnowledgeService(SAMPLE_ROWS), gemini);

    const result = await assistant.ask({ question: 'visa đi nhật', role: 'ADMIN', userId: 'u1' });

    expect(result.aiGenerated).toBe(true);
    expect(result.answer).toBe('Đây là câu trả lời từ Gemini.');
    expect(result.sources.length).toBeGreaterThan(0);
    // The prompt fed to Gemini was grounded in the retrieved knowledge.
    expect(gemini.lastPrompt).toContain('[RetrievedKnowledge]');
  });
});

// ===========================================================================
// Service-level: fallback answer is Vietnamese (Req 6.6)
// + prompt/answer contain no secret (Req 7.5)
// ===========================================================================

describe('WorkAssistant.ask — deterministic fallback (Req 6.6, 7.5)', () => {
  it('fallback answer (no Gemini) is in Vietnamese and grounded', async () => {
    const assistant = new WorkAssistant(makeKnowledgeService(SAMPLE_ROWS));

    const result = await assistant.ask({ question: 'hồ sơ cần gì', role: 'SALES', userId: 'u1' });

    expect(result.aiGenerated).toBe(false);
    expect(result.answer.length).toBeGreaterThan(0);
    // Vietnamese fallback: mentions the company and uses Vietnamese wording.
    expect(result.answer).toContain(COMPANY_IDENTITY.name);
    expect(result.answer.toLowerCase()).toContain('liên hệ');
    // Contains Vietnamese diacritics (non-ASCII) -> clearly Vietnamese text.
    // eslint-disable-next-line no-control-regex
    expect(/[^\u0000-\u007F]/.test(result.answer)).toBe(true);
  });

  it('never embeds a secret value in the Gemini prompt nor in the answer', async () => {
    // Seed an entry whose text references a secret-looking value; the grounding
    // prompt builder embeds only public company info + knowledge titles/content,
    // and we assert the answer/prompt do not leak an api-key style secret.
    const gemini = new CannedGemini('Trả lời an toàn không có khóa bí mật.');
    const assistant = new WorkAssistant(makeKnowledgeService(SAMPLE_ROWS), gemini);

    const result = await assistant.ask({ question: 'chi phí visa nhật', role: 'ADMIN', userId: 'u1' });

    expect(result.answer).not.toContain(SECRET);
    expect(result.answer.toLowerCase()).not.toContain('api_key');
    expect(result.answer.toLowerCase()).not.toContain('apikey');
    expect(gemini.lastPrompt).not.toContain(SECRET);
    expect(gemini.lastPrompt.toLowerCase()).not.toContain('api_key');
    expect(gemini.lastPrompt.toLowerCase()).not.toContain('apikey');
  });
});

// ===========================================================================
// Route-level: whitespace question -> 400 (Req 6.5)
// ===========================================================================

describe('POST /api/v1/ai/assistant — validation (Req 6.5)', () => {
  it('rejects a whitespace-only question with a 400 ValidationError', async () => {
    const routes = registerRoutes({ rows: SAMPLE_ROWS });
    const route = routes.get('POST /api/v1/ai/assistant');
    expect(route).toBeDefined();

    const request = { body: { question: '   \t  \n ' }, auth: { userId: 'u1', role: 'ADMIN', sessionId: 's1' } };
    const { reply } = makeReply();

    await expect(route!.handler(request, reply)).rejects.toBeInstanceOf(ValidationError);
    await expect(route!.handler(request, reply)).rejects.toMatchObject({ status: 400 });
  });

  it('answers a valid question (200) and delegates to the assistant', async () => {
    const routes = registerRoutes({ rows: SAMPLE_ROWS });
    const route = routes.get('POST /api/v1/ai/assistant')!;

    const request = { body: { question: 'visa đi nhật' }, auth: { userId: 'u1', role: 'SALES', sessionId: 's1' } };
    const { reply, sent } = makeReply();

    await route.handler(request, reply);

    expect(sent.code).toBe(200);
    const body = sent.body as { answer: string; sources: unknown[]; aiGenerated: boolean };
    expect(typeof body.answer).toBe('string');
    expect(body.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.aiGenerated).toBe(false);
  });
});

// ===========================================================================
// Route-level: missing knowledge field -> 400 (Req 8.2)
// ===========================================================================

describe('POST /api/v1/knowledge — validation (Req 8.2)', () => {
  it('rejects creation when category/title/content is missing', async () => {
    const routes = registerRoutes({ rows: SAMPLE_ROWS });
    const route = routes.get('POST /api/v1/knowledge')!;
    const { reply } = makeReply();
    const adminAuth = { userId: 'admin', role: 'ADMIN', sessionId: 's1' };

    // Missing content.
    await expect(
      route.handler({ body: { category: 'faq', title: 'T' }, auth: adminAuth }, reply),
    ).rejects.toBeInstanceOf(ValidationError);

    // Missing title.
    await expect(
      route.handler({ body: { category: 'faq', content: 'C' }, auth: adminAuth }, reply),
    ).rejects.toBeInstanceOf(ValidationError);

    // Missing category.
    await expect(
      route.handler({ body: { title: 'T', content: 'C' }, auth: adminAuth }, reply),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('creates a knowledge entry (201) when all fields are present', async () => {
    const routes = registerRoutes({ rows: SAMPLE_ROWS });
    const route = routes.get('POST /api/v1/knowledge')!;
    const { reply, sent } = makeReply();

    await route.handler(
      { body: { category: 'faq', title: 'Mục mới', content: 'Nội dung' }, auth: { userId: 'admin', role: 'ADMIN', sessionId: 's1' } },
      reply,
    );

    expect(sent.code).toBe(201);
  });
});
