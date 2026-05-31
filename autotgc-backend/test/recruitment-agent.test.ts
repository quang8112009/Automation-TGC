/**
 * Tests for the AI recruitment-consultant agent + knowledge base
 * (customer: Thanh Giang Conincon, retrieval-grounding feature).
 *
 * Property tests are tagged `// Feature: recruitment-agent, Property {n}: ...`.
 * Determinism: the Gemini seam and KnowledgeService are stubbed; the agent's
 * pure ranking / prompt-building helpers need no I/O.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { JobOrder, KnowledgeEntry } from '@prisma/client';

import {
  buildSystemPrompt,
  suggestJobOrders,
  RecruitmentConsultantAgent,
} from '../src/recruitment/agent/consultantAgent';
import type { CandidateContext } from '../src/recruitment/agent/consultantAgent';
import {
  scoreEntry,
  rankRows,
  KnowledgeService,
  toRankable,
} from '../src/recruitment/knowledge/knowledgeService';
import { KNOWLEDGE_BASE, COMPANY_IDENTITY } from '../src/recruitment/knowledge/knowledgeBase';
import type { ContentGenerator } from '../src/strategy/personaService';
import { AppError } from '../src/infra/errors';

// ===========================================================================
// Fixtures / factories
// ===========================================================================

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

const NOW = new Date('2025-06-01T00:00:00.000Z');

/** Build a full JobOrder row from partial overrides. */
function jobOrder(overrides: Partial<JobOrder> = {}): JobOrder {
  return {
    id: nextId('jo'),
    code: nextId('CODE'),
    title: 'Đơn hàng mẫu',
    industry: '',
    visaType: 'TOKUTEI',
    market: 'JAPAN',
    workLocation: '',
    salaryText: '',
    salaryMinVndM: null,
    salaryMaxVndM: null,
    quantity: 1,
    gender: 'ANY',
    nationalityReq: '',
    status: 'OPEN',
    deadline: null,
    description: '',
    sourcePostId: null,
    branchId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as JobOrder;
}

/** Build a full KnowledgeEntry row from partial overrides. */
function knowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: nextId('kb'),
    category: 'faq',
    title: 'Mục mẫu',
    content: 'Nội dung mẫu.',
    tags: [],
    market: null,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as KnowledgeEntry;
}

/** Materialize the curated KNOWLEDGE_BASE as KnowledgeEntry rows. */
function curatedRows(): KnowledgeEntry[] {
  return KNOWLEDGE_BASE.map((seed) =>
    knowledgeEntry({
      category: seed.category,
      title: seed.title,
      content: seed.content,
      tags: seed.tags,
      market: seed.market ?? null,
    }),
  );
}

/** A Gemini stub that always throws (simulates not-configured / failure). */
class ThrowingGemini implements ContentGenerator {
  async generateContent(): Promise<string> {
    throw new AppError(502, 'AI not configured', 'AI_NOT_CONFIGURED');
  }
}

/** A Gemini stub that returns a canned answer. */
class CannedGemini implements ContentGenerator {
  lastPrompt = '';
  constructor(private readonly response: string) {}
  async generateContent(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return this.response;
  }
}

/** A KnowledgeService stub backed by an in-memory row list (uses real ranking). */
function fakeKnowledgeService(rows: KnowledgeEntry[]): KnowledgeService {
  return {
    search: async (query: string, limit = 5) => rankRows(rows, query, limit),
    list: async () => rows,
  } as unknown as KnowledgeService;
}

// ===========================================================================
// fast-check arbitraries
// ===========================================================================

const MARKETS = ['JAPAN', 'GERMANY', 'KOREA', 'TAIWAN', 'DOMESTIC'] as const;
const VISAS = ['TOKUTEI', 'ENGINEER', 'TRAINEE', 'STUDENT'] as const;
const INDUSTRIES = ['Điều dưỡng', 'Xây dựng', 'Cơ khí', 'May mặc', 'Nông nghiệp'] as const;
const GENDERS = ['MALE', 'FEMALE', 'ANY'] as const;

const marketArb = fc.constantFrom(...MARKETS);
const visaArb = fc.constantFrom(...VISAS);
const industryArb = fc.constantFrom(...INDUSTRIES);
const genderArb = fc.constantFrom(...GENDERS);
const statusArb = fc.constantFrom('OPEN', 'PAUSED', 'CLOSED', 'FILLED');

const jobOrderArb: fc.Arbitrary<JobOrder> = fc.record({
  market: marketArb,
  visaType: visaArb,
  industry: industryArb,
  gender: genderArb,
  status: statusArb,
}).map((r) =>
  jobOrder({
    market: r.market as JobOrder['market'],
    visaType: r.visaType as JobOrder['visaType'],
    industry: r.industry,
    gender: r.gender,
    status: r.status as JobOrder['status'],
  }),
);

const candidateArb: fc.Arbitrary<CandidateContext> = fc.record({
  desiredMarket: fc.option(marketArb, { nil: undefined }),
  desiredVisaType: fc.option(visaArb, { nil: undefined }),
  desiredIndustry: fc.option(industryArb, { nil: undefined }),
  gender: fc.option(fc.constantFrom('MALE', 'FEMALE'), { nil: undefined }),
});

// ===========================================================================
// Property 1 — job-order match ranking
// ===========================================================================

describe('Property 1: job-order match ranking', () => {
  // Feature: recruitment-agent, Property 1: job-order match ranking
  it('only returns OPEN orders and is deterministic across runs', () => {
    fc.assert(
      fc.property(candidateArb, fc.array(jobOrderArb, { maxLength: 12 }), (candidate, orders) => {
        const a = suggestJobOrders(candidate, orders);
        const b = suggestJobOrders(candidate, orders);

        // Only OPEN orders are ever suggested.
        for (const s of a) {
          expect(s.jobOrder.status).toBe('OPEN');
        }
        // Deterministic: same input -> identical ranked ids + scores.
        expect(a.map((s) => `${s.jobOrder.id}:${s.score}`)).toEqual(
          b.map((s) => `${s.jobOrder.id}:${s.score}`),
        );
        // Scores are non-increasing.
        for (let i = 1; i < a.length; i += 1) {
          expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: recruitment-agent, Property 1: job-order match ranking
  it('a perfect market+industry+visa match ranks above a partial match', () => {
    fc.assert(
      fc.property(marketArb, visaArb, industryArb, (market, visa, industry) => {
        const candidate: CandidateContext = {
          desiredMarket: market,
          desiredVisaType: visa,
          desiredIndustry: industry,
        };
        // Pick a different market for the partial order so it cannot match market.
        const otherMarket = MARKETS.find((m) => m !== market) ?? market;

        const perfect = jobOrder({
          code: 'PERFECT',
          market: market as JobOrder['market'],
          visaType: visa as JobOrder['visaType'],
          industry,
          status: 'OPEN',
        });
        const partial = jobOrder({
          code: 'PARTIAL',
          market: otherMarket as JobOrder['market'],
          visaType: visa as JobOrder['visaType'],
          industry: 'Ngành khác hoàn toàn',
          status: 'OPEN',
        });

        const ranked = suggestJobOrders(candidate, [partial, perfect]);
        expect(ranked.length).toBeGreaterThanOrEqual(1);
        expect(ranked[0].jobOrder.code).toBe('PERFECT');

        const perfectScore = ranked.find((s) => s.jobOrder.code === 'PERFECT')?.score ?? 0;
        const partialScore = ranked.find((s) => s.jobOrder.code === 'PARTIAL')?.score ?? 0;
        expect(perfectScore).toBeGreaterThan(partialScore);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 2 — system prompt structure & safety
// ===========================================================================

describe('Property 2: system prompt structure and secret safety', () => {
  const SECRET = 'sk-super-secret-key-1234567890';

  // Feature: recruitment-agent, Property 2: system prompt ordering + no secrets
  it('always includes company identity then retrieved-knowledge in fixed order, no secrets', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.array(
          fc.record({
            category: fc.constantFrom('company', 'market', 'visa', 'industry', 'faq'),
            title: fc.string({ minLength: 1, maxLength: 20 }),
            content: fc.string({ minLength: 1, maxLength: 40 }),
          }),
          { maxLength: 5 },
        ),
        candidateArb,
        (question, rawEntries, candidate) => {
          const rows = rawEntries.map((e) =>
            knowledgeEntry({ category: e.category, title: e.title, content: e.content }),
          );
          const prompt = buildSystemPrompt(question, rows, candidate);

          const companyIdx = prompt.indexOf('[CompanyRole]');
          const knowledgeIdx = prompt.indexOf('[RetrievedKnowledge]');
          const answerIdx = prompt.indexOf('[AnswerInstructions]');

          // All required segments present.
          expect(companyIdx).toBeGreaterThanOrEqual(0);
          expect(knowledgeIdx).toBeGreaterThanOrEqual(0);
          expect(answerIdx).toBeGreaterThanOrEqual(0);

          // Fixed order: company -> knowledge -> answer-instructions (last).
          expect(companyIdx).toBeLessThan(knowledgeIdx);
          expect(knowledgeIdx).toBeLessThan(answerIdx);

          // Company identity is named.
          expect(prompt).toContain(COMPANY_IDENTITY.name);

          // The prompt never contains a secret-like API key value.
          expect(prompt).not.toContain(SECRET);
          expect(prompt.toLowerCase()).not.toContain('api_key');
          expect(prompt.toLowerCase()).not.toContain('apikey');
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Unit — consult grounded fallback
// ===========================================================================

describe('consult() grounded fallback (Gemini not configured)', () => {
  it('returns aiGenerated:false with non-empty sources when Gemini throws', async () => {
    const rows = curatedRows();
    const agent = new RecruitmentConsultantAgent(fakeKnowledgeService(rows), new ThrowingGemini());

    const result = await agent.consult('điều dưỡng nhật bản');

    expect(result.aiGenerated).toBe(false);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.answer.length).toBeGreaterThan(0);
    // The grounded answer is assembled from the retrieved sources.
    expect(result.answer).toContain(result.sources[0].title);
    // It mentions the company so it is clearly a knowledge-based response.
    expect(result.answer).toContain(COMPANY_IDENTITY.name);
  });

  it('uses Gemini output (aiGenerated:true) when configured and successful', async () => {
    const rows = curatedRows();
    const gemini = new CannedGemini('Câu trả lời từ Gemini.');
    const agent = new RecruitmentConsultantAgent(fakeKnowledgeService(rows), gemini);

    const result = await agent.consult('chi phí đi nhật');

    expect(result.aiGenerated).toBe(true);
    expect(result.answer).toBe('Câu trả lời từ Gemini.');
    expect(result.sources.length).toBeGreaterThan(0);
    // The prompt handed to Gemini was grounded in the retrieved knowledge.
    expect(gemini.lastPrompt).toContain('[RetrievedKnowledge]');
  });

  it('with no Gemini seam at all, still returns a grounded answer', async () => {
    const rows = curatedRows();
    const agent = new RecruitmentConsultantAgent(fakeKnowledgeService(rows));

    const result = await agent.consult('thực tập sinh xây dựng');

    expect(result.aiGenerated).toBe(false);
    expect(result.answer.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Unit — knowledge search ranking relevance
// ===========================================================================

describe('knowledge search ranking', () => {
  it('ranks relevant entries first for "điều dưỡng nhật bản"', () => {
    const rows = curatedRows();
    const results = rankRows(rows, 'điều dưỡng nhật bản', 5);

    expect(results.length).toBeGreaterThan(0);
    // The nursing/care industry entry should surface near the top.
    const topTitles = results.slice(0, 3).map((r) => r.title);
    expect(topTitles.some((t) => t.toLowerCase().includes('điều dưỡng'))).toBe(true);
  });

  it('scoreEntry rewards tag and title matches over content-only matches', () => {
    const tagged = knowledgeEntry({
      title: 'Ngành Điều dưỡng - Hộ lý',
      content: 'Thông tin chung.',
      tags: ['điều dưỡng', 'kaigo'],
    });
    const contentOnly = knowledgeEntry({
      title: 'Mục khác',
      content: 'Có nhắc tới điều dưỡng một lần.',
      tags: [],
    });
    expect(scoreEntry(toRankable(tagged), 'điều dưỡng')).toBeGreaterThan(
      scoreEntry(toRankable(contentOnly), 'điều dưỡng'),
    );
  });

  it('returns nothing for an empty or whitespace query', () => {
    const rows = curatedRows();
    expect(rankRows(rows, '   ', 5)).toEqual([]);
  });
});

// ===========================================================================
// Unit — seed idempotency (in-memory Prisma fake)
// ===========================================================================

describe('KnowledgeService.seed idempotency', () => {
  it('creates on first run and updates (no duplicates) on second run', async () => {
    const store = new Map<string, KnowledgeEntry>();
    let seq = 0;
    const prisma = {
      knowledgeEntry: {
        findFirst: async (args: { where: { category: string; title: string } }) => {
          for (const row of store.values()) {
            if (row.category === args.where.category && row.title === args.where.title) return row;
          }
          return null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          const row = knowledgeEntry({ id: `seed-${++seq}`, ...(args.data as Partial<KnowledgeEntry>) });
          store.set(row.id, row);
          return row;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...store.get(args.where.id)!, ...(args.data as Partial<KnowledgeEntry>) };
          store.set(args.where.id, row);
          return row;
        },
      },
    } as unknown as ConstructorParameters<typeof KnowledgeService>[0];

    const service = new KnowledgeService(prisma);

    const first = await service.seed();
    expect(first.created).toBe(KNOWLEDGE_BASE.length);
    expect(first.updated).toBe(0);
    expect(store.size).toBe(KNOWLEDGE_BASE.length);

    const second = await service.seed();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(KNOWLEDGE_BASE.length);
    expect(store.size).toBe(KNOWLEDGE_BASE.length); // no duplicates
  });
});
