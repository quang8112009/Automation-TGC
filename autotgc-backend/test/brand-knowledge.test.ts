/**
 * Tests for the marketing brand-knowledge grounding seam (customer: Thanh Giang
 * — Vietnamese labor-export / XKLĐ). Proves that every marketing AI generator can
 * be grounded in the curated company knowledge base, the same way the
 * recruitment-consultant agent already is.
 *
 * Property test is tagged `// Feature: marketing-autopilot, Property 7: brand grounding block`.
 * Determinism: the KnowledgeService + Gemini seams are stubbed; the pure
 * `composeGroundingBlock` helper needs no I/O.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { KnowledgeEntry } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { ContentGenerator } from '../src/strategy/personaService';
import type {
  AiPromptContextReader,
  PerformanceContext,
} from '../src/content/generationService';
import {
  composeGroundingBlock,
  companyIdentityLine,
  KnowledgeBrandProvider,
  DEFAULT_GROUNDING_LIMIT,
} from '../src/marketing/brandKnowledge';
import type { BrandKnowledgeProvider } from '../src/marketing/brandKnowledge';
import { KnowledgeService } from '../src/recruitment/knowledge/knowledgeService';
import { COMPANY_IDENTITY } from '../src/recruitment/knowledge/knowledgeBase';
import { MultiFormatGenerator } from '../src/marketing/content/multiFormatGenerator';

// ===========================================================================
// Fixtures / test doubles
// ===========================================================================

const NOW = new Date('2025-06-01T00:00:00.000Z');
let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/** Build a full KnowledgeEntry row from partial overrides. */
function knowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: nextId('kb'),
    category: 'company',
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

/** A KnowledgeService stub returning canned entries for search + list. */
function fakeKnowledgeService(canned: {
  search?: KnowledgeEntry[];
  company?: KnowledgeEntry[];
  market?: KnowledgeEntry[];
}): KnowledgeService {
  return {
    search: async () => canned.search ?? [],
    list: async (category?: string, _market?: string) => {
      if (category === 'company') return canned.company ?? [];
      if (category === 'market') return canned.market ?? [];
      return [];
    },
  } as unknown as KnowledgeService;
}

/** A KnowledgeService stub whose every method throws (DB hiccup simulation). */
function throwingKnowledgeService(): KnowledgeService {
  return {
    search: async () => {
      throw new Error('db down');
    },
    list: async () => {
      throw new Error('db down');
    },
  } as unknown as KnowledgeService;
}

/** Captures the last prompt; returns a canned response. */
class CapturingGemini implements ContentGenerator {
  lastPrompt = '';
  calls = 0;
  constructor(private readonly response: string) {}
  async generateContent(prompt: string): Promise<string> {
    this.calls += 1;
    this.lastPrompt = prompt;
    return this.response;
  }
}

/** A brandKnowledge stub returning a fixed, recognizable block. */
const STUB_BLOCK = '[CongTy] STUB-IDENTITY Thanh Giang\n[TriThuc] Tri thức nền liên quan:\n- Mục: Nội dung';
class StubBrandKnowledge implements BrandKnowledgeProvider {
  calls = 0;
  lastOpts: unknown;
  async groundingBlock(opts: unknown): Promise<string> {
    this.calls += 1;
    this.lastOpts = opts;
    return STUB_BLOCK;
  }
}

/** Minimal Prisma fake for MultiFormatGenerator.generate. */
function fakeGenerationPrisma(): { prisma: PrismaClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    domainContext: {
      findUnique: async () => ({
        id: 'dom-1',
        domainName: 'XKLD Nhat Ban',
        contextDescription: 'Tu van xuat khau lao dong.',
        defaultToneOfVoice: 'than thien',
      }),
    },
    contentPersona: {
      findMany: async () => [
        {
          id: 'per-1',
          personaName: 'Lao dong tre',
          age: '20-30',
          interests: 'thu nhap cao',
          targetNeeds: 'di nuoc ngoai lam viec',
          painPoints: 'lo chi phi',
          toneOfVoice: 'dong vien',
          recommendedTone: null,
          domainId: 'dom-1',
        },
      ],
    },
    contentDraft: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'draft-1', ...args.data, ctas: [] };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, created };
}

const reader = (ctx: PerformanceContext | null): AiPromptContextReader => ({ get: async () => ctx });

/** A canned, valid GENERIC payload. */
const CANNED_GENERIC = JSON.stringify({
  title: 'Tieu de mau',
  body: 'Noi dung mau.',
  ctas: ['Dang ky ngay'],
});

// ===========================================================================
// fast-check arbitraries
// ===========================================================================

const entryArb: fc.Arbitrary<{ title: string; content: string }> = fc
  .record({
    title: fc.string({ minLength: 1, maxLength: 40 }),
    content: fc.string({ maxLength: 400 }),
  })
  // Strip newlines (so each entry renders to exactly one bullet line) and any
  // secret-like tokens from the (random) INPUT, so the assertions about line
  // structure and secret-freedom are meaningful. The curated KB is single-line
  // per field and never contains such tokens.
  .map((e) => ({
    title: e.title.replace(/[\r\n]+/g, ' ').replace(/sk-/gi, 'x').replace(/AIza/gi, 'y'),
    content: e.content.replace(/[\r\n]+/g, ' ').replace(/sk-/gi, 'x').replace(/AIza/gi, 'y'),
  }));

// ===========================================================================
// Property 7 — brand grounding block
// ===========================================================================

describe('Property 7: brand grounding block', () => {
  // Feature: marketing-autopilot, Property 7: brand grounding block
  it('composeGroundingBlock is deterministic, identity-first, capped, title-bearing, secret-free', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 12 }),
        fc.integer({ min: 1, max: 10 }),
        (entries, limit) => {
          const identity = companyIdentityLine();
          const a = composeGroundingBlock(identity, entries, limit);
          const b = composeGroundingBlock(identity, entries, limit);

          // Deterministic: identical inputs -> identical output.
          expect(a).toBe(b);

          // Always STARTS with the identity line.
          expect(a.startsWith(identity)).toBe(true);

          // Includes AT MOST `limit` entries (one `- ` bullet line per entry).
          const bulletCount = a.split('\n').filter((l) => l.startsWith('- ')).length;
          expect(bulletCount).toBeLessThanOrEqual(limit);
          expect(bulletCount).toBeLessThanOrEqual(entries.length);

          // Every included entry's title appears in the block.
          const included = entries.slice(0, limit);
          for (const e of included) {
            expect(a).toContain(e.title);
          }

          // Never contains secret-like tokens.
          expect(a).not.toContain('sk-');
          expect(a).not.toContain('AIza');
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Unit — KnowledgeBrandProvider.groundingBlock
// ===========================================================================

describe('KnowledgeBrandProvider.groundingBlock', () => {
  it('returns a block containing the company identity + the retrieved entries', async () => {
    const company = knowledgeEntry({
      category: 'company',
      title: 'Giới thiệu Thanh Giang Conincon',
      content: 'Công ty XKLĐ thành lập 2011.',
    });
    const marketEntry = knowledgeEntry({
      category: 'market',
      title: 'Thị trường Nhật Bản',
      content: 'Nhật Bản là thị trường trọng điểm.',
      market: 'JAPAN',
    });
    const searched = knowledgeEntry({
      category: 'visa',
      title: 'Diện Kỹ năng đặc định (Tokutei / SSW)',
      content: 'Tokutei dành cho lao động có kỹ năng.',
    });

    const provider = new KnowledgeBrandProvider(
      fakeKnowledgeService({ search: [searched], company: [company], market: [marketEntry] }),
    );
    const block = await provider.groundingBlock({ market: 'JAPAN', topic: 'tokutei' });

    // Company identity line is present and named.
    expect(block).toContain('[CongTy]');
    expect(block).toContain(COMPANY_IDENTITY.name);
    // The knowledge block + each retrieved entry title is present.
    expect(block).toContain('[TriThuc]');
    expect(block).toContain(company.title);
    expect(block).toContain(marketEntry.title);
    expect(block).toContain(searched.title);
    // No secrets.
    expect(block).not.toContain('sk-');
    expect(block).not.toContain('AIza');
  });

  it('de-dupes entries that appear via both search and list', async () => {
    const shared = knowledgeEntry({
      category: 'company',
      title: 'Giới thiệu Thanh Giang Conincon',
      content: 'Công ty XKLĐ.',
    });
    const provider = new KnowledgeBrandProvider(
      // Same row returned by search AND company list -> must appear once.
      fakeKnowledgeService({ search: [shared], company: [shared] }),
    );
    const block = await provider.groundingBlock({ topic: 'giới thiệu' });
    const occurrences = block.split(shared.title).length - 1;
    expect(occurrences).toBe(1);
  });

  it('on ANY KnowledgeService error returns just the company-identity line (no throw)', async () => {
    const provider = new KnowledgeBrandProvider(throwingKnowledgeService());
    const block = await provider.groundingBlock({ market: 'JAPAN', topic: 'lương' });
    expect(block).toBe(companyIdentityLine());
    // Identity-only: no knowledge block.
    expect(block).not.toContain('[TriThuc]');
  });

  it('caps the rendered entries at the requested limit', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      knowledgeEntry({ category: 'company', title: `Entry ${i}`, content: `Content ${i}` }),
    );
    const provider = new KnowledgeBrandProvider(fakeKnowledgeService({ company: many }));
    const block = await provider.groundingBlock({ topic: 'x', limit: 3 });
    const bulletCount = block.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(bulletCount).toBe(3);
  });

  it('defaults to DEFAULT_GROUNDING_LIMIT entries when no limit is given', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      knowledgeEntry({ category: 'company', title: `Row ${i}`, content: `Body ${i}` }),
    );
    const provider = new KnowledgeBrandProvider(fakeKnowledgeService({ company: many }));
    const block = await provider.groundingBlock({ topic: 'y' });
    const bulletCount = block.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(bulletCount).toBe(DEFAULT_GROUNDING_LIMIT);
  });
});

// ===========================================================================
// Unit — MultiFormatGenerator grounding injection (back-compat preserved)
// ===========================================================================

describe('MultiFormatGenerator grounding injection', () => {
  it('with a brandKnowledge stub → the prompt CONTAINS the grounding block and still persists a DRAFT', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(CANNED_GENERIC);
    const brand = new StubBrandKnowledge();
    const service = new MultiFormatGenerator(prisma, gemini, reader(null), brand);

    const result = await service.generate({
      format: 'GENERIC',
      domainName: 'XKLD Nhat Ban',
      personaIds: ['per-1'],
      objective: 'Lead',
      market: 'JAPAN',
      topic: 'di nhat ban',
      keyword: 'luong nhat ban',
    });

    // The grounding block was fetched and injected into the Gemini prompt.
    expect(brand.calls).toBe(1);
    expect(gemini.lastPrompt).toContain(STUB_BLOCK);
    // Grounding precedes the expert-role directive (grounded BEFORE the role).
    expect(gemini.lastPrompt.indexOf(STUB_BLOCK)).toBeLessThan(
      gemini.lastPrompt.indexOf('[ExpertRole]'),
    );
    // Output contract stays last.
    expect(gemini.lastPrompt.indexOf('[OutputContract]')).toBeGreaterThan(
      gemini.lastPrompt.indexOf('[ExpertRole]'),
    );

    // A DRAFT is still persisted.
    expect(result.aiGenerated).toBe(true);
    expect(created).toHaveLength(1);
    expect((created[0] as { status: string }).status).toBe('DRAFT');
  });

  it('without brandKnowledge → the prompt has NO grounding block (byte-compatible back-compat)', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(CANNED_GENERIC);
    const service = new MultiFormatGenerator(prisma, gemini, reader(null)); // no brandKnowledge

    await service.generate({
      format: 'GENERIC',
      domainName: 'XKLD Nhat Ban',
      personaIds: ['per-1'],
      objective: 'Lead',
      market: 'JAPAN',
    });

    // No [CongTy]/[TriThuc] grounding; prompt begins with the expert-role directive.
    expect(gemini.lastPrompt).not.toContain('[CongTy]');
    expect(gemini.lastPrompt).not.toContain('[TriThuc]');
    expect(gemini.lastPrompt.startsWith('[ExpertRole]')).toBe(true);
    expect(created).toHaveLength(1);
  });
});
