import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import type { ContentGenerator } from '../src/strategy/personaService';
import type {
  AiPromptContextReader,
  PerformanceContext,
} from '../src/content/generationService';
import {
  CONTENT_FORMATS,
  FORMAT_META,
  isContentFormat,
} from '../src/marketing/content/formats';
import type { ContentFormat } from '../src/marketing/content/formats';
import {
  MultiFormatGenerator,
  buildFormatPrompt,
  outputContract,
  DEFAULT_CARE_CTA,
} from '../src/marketing/content/multiFormatGenerator';
import type { FormatPromptInputs } from '../src/marketing/content/multiFormatGenerator';
import { AppError } from '../src/infra/errors';

// ---- Test doubles -----------------------------------------------------------

/** Captures the last prompt + counts calls; returns a canned response. */
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

/** A Gemini double that always fails like an unconfigured client (502). */
class UnconfiguredGemini implements ContentGenerator {
  calls = 0;
  async generateContent(): Promise<string> {
    this.calls += 1;
    throw new AppError(502, 'AI not configured', 'AI_NOT_CONFIGURED');
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

/** A canned, valid payload for a given format. */
function cannedPayload(format: ContentFormat): string {
  const base: Record<string, unknown> = {
    title: 'Tieu de mau',
    body: 'Noi dung mau cho dinh dang.',
  };
  if (format === 'SEO_ARTICLE') {
    base.metaDescription = 'Mo ta SEO.';
    base.body = '## H2\nNoi dung\n### H3\nChi tiet';
    base.keywords = ['lương nhật bản', 'visa tokutei'];
  }
  if (FORMAT_META[format].ctasRequired) {
    base.ctas = ['Dang ky ngay'];
  } else {
    base.ctas = [];
  }
  return JSON.stringify(base);
}

const reader = (ctx: PerformanceContext | null): AiPromptContextReader => ({ get: async () => ctx });

// ---- Generators -------------------------------------------------------------

const formatArb = fc.constantFrom<ContentFormat>(...CONTENT_FORMATS);
const objectiveArb = fc.constantFrom('Lead', 'View', 'Follow' as const);

const promptInputsArb: fc.Arbitrary<FormatPromptInputs> = fc.record({
  domainName: fc.string({ minLength: 1, maxLength: 20 }),
  domainContext: fc.string({ maxLength: 30 }),
  personaSummaries: fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 1, maxLength: 3 }),
  toneOfVoice: fc.string({ minLength: 1, maxLength: 15 }),
  objective: objectiveArb,
  market: fc.option(fc.constantFrom('JAPAN', 'KOREA', 'GERMANY', 'EUROPE' as const), { nil: undefined }),
  topic: fc.option(fc.string({ minLength: 1, maxLength: 15 }), { nil: undefined }),
  keyword: fc.option(fc.string({ minLength: 1, maxLength: 15 }), { nil: undefined }),
  seoKeywords: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 3 }),
});

const completeCtxArb: fc.Arbitrary<PerformanceContext> = fc.record({
  topPerformingTopics: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
  bestCtaPatterns: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
  avoidTopics: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
  optimalContentLength: fc.record({ min: fc.integer(), max: fc.integer() }),
});

// An empty/cold-start context: at least one performance field is empty/missing.
const incompleteCtxArb: fc.Arbitrary<PerformanceContext | null> = fc.oneof(
  fc.constant(null),
  fc.record({
    topPerformingTopics: fc.constantFrom([], '', null),
    bestCtaPatterns: fc.constantFrom([], '', null),
    avoidTopics: fc.constantFrom([], '', null),
    optimalContentLength: fc.constantFrom([], '', null),
  }) as unknown as fc.Arbitrary<PerformanceContext>,
);

describe('multi-format prompt construction', () => {
  // Feature: marketing-autopilot, Property 3: multi-format prompt ordering
  it('Property 3: buildFormatPrompt emits the format directive, objective, and JSON-output instruction in fixed order (output LAST), with the performance segment iff ctx complete', () => {
    fc.assert(
      fc.property(
        formatArb,
        promptInputsArb,
        fc.option(completeCtxArb, { nil: null }),
        (format, inputs, ctx) => {
          const prompt = buildFormatPrompt(format, inputs, ctx);

          const directivePos = prompt.indexOf(`[Format:${format}]`);
          const objectivePos = prompt.indexOf('[Objective]');
          const outputPos = prompt.indexOf('[OutputContract]');

          // Format directive present and first; objective present and after it.
          expect(directivePos).toBeGreaterThanOrEqual(0);
          expect(objectivePos).toBeGreaterThan(directivePos);

          // Output-contract instruction present and ALWAYS last.
          expect(outputPos).toBeGreaterThan(objectivePos);
          expect(outputPos).toBe(Math.max(...allSegmentPositions(prompt)));

          // Performance segment present iff the context is complete, and always
          // strictly before the output contract.
          const perfPos = prompt.indexOf('[PerformanceContext]');
          if (ctx !== null && isComplete(ctx)) {
            expect(perfPos).toBeGreaterThan(objectivePos);
            expect(outputPos).toBeGreaterThan(perfPos);
          } else {
            expect(perfPos).toBe(-1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** Local mirror of isPerformanceContextComplete for the property assertions. */
function isComplete(ctx: PerformanceContext): boolean {
  const nonEmpty = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v as object).length > 0;
    return true;
  };
  return (
    nonEmpty(ctx.topPerformingTopics) &&
    nonEmpty(ctx.bestCtaPatterns) &&
    nonEmpty(ctx.avoidTopics) &&
    nonEmpty(ctx.optimalContentLength)
  );
}

/** Positions of all known prompt segment tags that are present. */
function allSegmentPositions(prompt: string): number[] {
  const tags = [
    '[ExpertRole]',
    '[DomainContext]',
    '[Persona]',
    '[Tone]',
    '[Objective]',
    '[Market]',
    '[Keyword]',
    '[PerformanceContext]',
    '[OutputContract]',
  ];
  return tags.map((t) => prompt.indexOf(t)).filter((p) => p >= 0);
}

describe('multi-format formats catalog', () => {
  it('isContentFormat accepts every canonical code and rejects others', () => {
    for (const f of CONTENT_FORMATS) expect(isContentFormat(f)).toBe(true);
    expect(isContentFormat('NOPE')).toBe(false);
    expect(isContentFormat(123)).toBe(false);
    expect(isContentFormat(undefined)).toBe(false);
  });

  it('outputContract is non-empty for every format', () => {
    for (const f of CONTENT_FORMATS) {
      expect(outputContract(f).length).toBeGreaterThan(0);
    }
  });
});

describe('multi-format generation (per format)', () => {
  for (const format of CONTENT_FORMATS) {
    it(`generate() persists a DRAFT with format=${format} and the requested market`, async () => {
      const { prisma, created } = fakeGenerationPrisma();
      const gemini = new CapturingGemini(cannedPayload(format));
      const service = new MultiFormatGenerator(prisma, gemini, reader(null));

      const result = await service.generate({
        format,
        domainName: 'XKLD Nhat Ban',
        personaIds: ['per-1'],
        objective: 'Lead',
        market: 'JAPAN',
        topic: 'di nhat ban',
        keyword: 'luong nhat ban',
      });

      expect(gemini.calls).toBe(1);
      expect(result.aiGenerated).toBe(true);
      expect(result.format).toBe(format);
      expect(created).toHaveLength(1);

      const data = created[0] as {
        format: string;
        market: string | null;
        language: string;
        status: string;
        ctas: { create: unknown[] };
      };
      expect(data.format).toBe(format);
      expect(data.market).toBe('JAPAN');
      expect(data.language).toBe('vi');
      expect(data.status).toBe('DRAFT');
      // The DraftCta >=1 UX invariant holds for every format (synthesized when optional).
      expect(data.ctas.create.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('SEO_ARTICLE persists model keywords into seoKeywords', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(cannedPayload('SEO_ARTICLE'));
    const service = new MultiFormatGenerator(prisma, gemini, reader(null));

    await service.generate({
      format: 'SEO_ARTICLE',
      domainName: 'XKLD Nhat Ban',
      personaIds: ['per-1'],
      objective: 'Lead',
      market: 'JAPAN',
    });

    const data = created[0] as { seoKeywords: unknown };
    expect(data.seoKeywords).toEqual(['lương nhật bản', 'visa tokutei']);
  });

  it('CARE_MESSAGE with zero CTAs synthesizes the default care CTA', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(cannedPayload('CARE_MESSAGE'));
    const service = new MultiFormatGenerator(prisma, gemini, reader(null));

    await service.generate({
      format: 'CARE_MESSAGE',
      domainName: 'XKLD Nhat Ban',
      personaIds: ['per-1'],
      objective: 'Lead',
    });

    const data = created[0] as { ctas: { create: Array<{ ctaText: string }> } };
    expect(data.ctas.create).toHaveLength(1);
    expect(data.ctas.create[0].ctaText).toBe(DEFAULT_CARE_CTA);
  });

  it('falls back to request seoKeywords when the model returns none (non-SEO format)', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(cannedPayload('FANPAGE_CAPTION'));
    const service = new MultiFormatGenerator(prisma, gemini, reader(null));

    await service.generate({
      format: 'FANPAGE_CAPTION',
      domainName: 'XKLD Nhat Ban',
      personaIds: ['per-1'],
      objective: 'View',
      seoKeywords: ['xkld nhat', 'don hang nhat'],
    });

    const data = created[0] as { seoKeywords: unknown; market: string | null };
    expect(data.seoKeywords).toEqual(['xkld nhat', 'don hang nhat']);
    expect(data.market).toBeNull();
  });
});

describe('multi-format validation (validate-before-AI)', () => {
  it('invalid format → 400 with NO Gemini call and nothing persisted', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(cannedPayload('GENERIC'));
    const service = new MultiFormatGenerator(prisma, gemini, reader(null));

    await expect(
      service.generate({
        format: 'NOT_A_FORMAT',
        domainName: 'XKLD Nhat Ban',
        personaIds: ['per-1'],
        objective: 'Lead',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'GEN_FORMAT_INVALID' });

    expect(gemini.calls).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('invalid objective → 400 with NO Gemini call', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(cannedPayload('GENERIC'));
    const service = new MultiFormatGenerator(prisma, gemini, reader(null));

    await expect(
      service.generate({
        format: 'SEO_ARTICLE',
        domainName: 'XKLD Nhat Ban',
        personaIds: ['per-1'],
        objective: 'Sales',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'GEN_OBJECTIVE_INVALID' });

    expect(gemini.calls).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('invalid market → 400 with NO Gemini call', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new CapturingGemini(cannedPayload('GENERIC'));
    const service = new MultiFormatGenerator(prisma, gemini, reader(null));

    await expect(
      service.generate({
        format: 'SEO_ARTICLE',
        domainName: 'XKLD Nhat Ban',
        personaIds: ['per-1'],
        objective: 'Lead',
        market: 'MARS',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'GEN_MARKET_INVALID' });

    expect(gemini.calls).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('an unconfigured/throwing Gemini → 502 and nothing persisted', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new UnconfiguredGemini();
    const service = new MultiFormatGenerator(prisma, gemini, reader(null));

    await expect(
      service.generate({
        format: 'EMAIL',
        domainName: 'XKLD Nhat Ban',
        personaIds: ['per-1'],
        objective: 'Lead',
        market: 'KOREA',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'AI_NOT_CONFIGURED' });

    expect(gemini.calls).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('cold-start (incomplete ctx) marks generatedWithoutFeedback and omits the performance segment', async () => {
    await fc.assert(
      fc.asyncProperty(incompleteCtxArb, async (ctx) => {
        const { prisma, created } = fakeGenerationPrisma();
        const gemini = new CapturingGemini(cannedPayload('VIDEO_SCRIPT'));
        const service = new MultiFormatGenerator(prisma, gemini, reader(ctx));

        const result = await service.generate({
          format: 'VIDEO_SCRIPT',
          domainName: 'XKLD Nhat Ban',
          personaIds: ['per-1'],
          objective: 'View',
        });

        expect(result.generatedWithoutFeedback).toBe(true);
        expect(gemini.lastPrompt.indexOf('[PerformanceContext]')).toBe(-1);
        const data = created[0] as { generatedWithoutFeedback: boolean };
        expect(data.generatedWithoutFeedback).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
