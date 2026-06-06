/**
 * Coverage for MultiFormatGenerator.generateStreaming, which previously had NO
 * direct test:
 *
 *  - When the injected generator SUPPORTS streamContent, deltas are forwarded
 *    and the full streamed text is parsed + persisted EXACTLY as generate().
 *  - When the injected generator does NOT support streamContent (a plain
 *    ContentGenerator), it FALLS BACK to generateContent — no deltas emitted —
 *    and still persists an identical DRAFT.
 *  - Validation (400) still runs before any AI call (no persistence).
 *  - An AI failure mid-stream is rethrown and nothing is persisted.
 *
 * Pure in-memory doubles, deterministic, no network.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ContentGenerator, GenerateOptions } from '../src/strategy/personaService';
import type { AiPromptContextReader } from '../src/content/generationService';
import { MultiFormatGenerator } from '../src/marketing/content/multiFormatGenerator';
import { FORMAT_META } from '../src/marketing/content/formats';
import { AppError } from '../src/infra/errors';

// ---- Doubles ----------------------------------------------------------------

/** A generator that supports streaming: splits the canned text into 2 chunks. */
class StreamingGemini implements ContentGenerator {
  generateCalls = 0;
  streamCalls = 0;
  lastMaxTokens?: number;
  constructor(private readonly response: string) {}
  async generateContent(_prompt: string, options?: GenerateOptions): Promise<string> {
    this.generateCalls += 1;
    this.lastMaxTokens = options?.maxTokens;
    return this.response;
  }
  async streamContent(
    _prompt: string,
    onDelta: (chunk: string) => void,
    options?: GenerateOptions,
  ): Promise<string> {
    this.streamCalls += 1;
    this.lastMaxTokens = options?.maxTokens;
    const mid = Math.floor(this.response.length / 2);
    onDelta(this.response.slice(0, mid));
    onDelta(this.response.slice(mid));
    return this.response;
  }
}

/** A plain generator with NO streamContent method (forces the fallback path). */
class NonStreamingGemini implements ContentGenerator {
  generateCalls = 0;
  lastMaxTokens?: number;
  constructor(private readonly response: string) {}
  async generateContent(_prompt: string, options?: GenerateOptions): Promise<string> {
    this.generateCalls += 1;
    this.lastMaxTokens = options?.maxTokens;
    return this.response;
  }
}

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

const reader: AiPromptContextReader = { get: async () => null };

const VALID_REQUEST = {
  format: 'FANPAGE_CAPTION' as const,
  domainName: 'XKLD Nhat Ban',
  personaIds: ['per-1'],
  objective: 'View' as const,
  market: 'JAPAN' as const,
};

const CANNED = JSON.stringify({ title: 'Tieu de', body: 'Noi dung mau day du.', ctas: ['Dang ky ngay'] });

describe('MultiFormatGenerator.generateStreaming', () => {
  it('uses streamContent when available: forwards deltas and persists the full text', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new StreamingGemini(CANNED);
    const svc = new MultiFormatGenerator(prisma, gemini, reader);

    const chunks: string[] = [];
    const result = await svc.generateStreaming(VALID_REQUEST, (c) => chunks.push(c));

    expect(gemini.streamCalls).toBe(1);
    expect(gemini.generateCalls).toBe(0);
    expect(chunks.join('')).toBe(CANNED);
    expect(result.format).toBe('FANPAGE_CAPTION');
    expect(created).toHaveLength(1);
    // Per-format max_tokens is forwarded to the streamer.
    expect(gemini.lastMaxTokens).toBe(FORMAT_META.FANPAGE_CAPTION.maxTokens);
  });

  it('FALLS BACK to generateContent when the generator has no streamContent (no deltas)', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new NonStreamingGemini(CANNED);
    const svc = new MultiFormatGenerator(prisma, gemini, reader);

    const chunks: string[] = [];
    const result = await svc.generateStreaming(VALID_REQUEST, (c) => chunks.push(c));

    expect(gemini.generateCalls).toBe(1);
    expect(chunks).toHaveLength(0); // no streaming => no deltas
    expect(result.format).toBe('FANPAGE_CAPTION');
    expect(created).toHaveLength(1);
    expect(gemini.lastMaxTokens).toBe(FORMAT_META.FANPAGE_CAPTION.maxTokens);
  });

  it('validates BEFORE any AI call: invalid format => 400, nothing streamed or persisted', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const gemini = new StreamingGemini(CANNED);
    const svc = new MultiFormatGenerator(prisma, gemini, reader);

    const chunks: string[] = [];
    await expect(
      svc.generateStreaming({ ...VALID_REQUEST, format: 'NOPE' }, (c) => chunks.push(c)),
    ).rejects.toMatchObject({ status: 400, code: 'GEN_FORMAT_INVALID' });

    expect(gemini.streamCalls).toBe(0);
    expect(gemini.generateCalls).toBe(0);
    expect(chunks).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('rethrows an AI failure raised mid-stream and persists nothing', async () => {
    const { prisma, created } = fakeGenerationPrisma();
    const failing: ContentGenerator & { streamContent: StreamingGemini['streamContent'] } = {
      async generateContent() {
        throw new Error('should not be called');
      },
      async streamContent() {
        throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
      },
    };
    const svc = new MultiFormatGenerator(prisma, failing, reader);

    await expect(svc.generateStreaming(VALID_REQUEST, () => {})).rejects.toMatchObject({
      status: 502,
      code: 'AI_REQUEST_FAILED',
    });
    expect(created).toHaveLength(0);
  });
});
