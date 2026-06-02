/**
 * Regression tests for the Self-Correction loop (proposal 3.1):
 * GenerationService.regenerateFromRejection + buildRegenerationPrompt.
 *
 * A REJECTED-then-returned draft (status DRAFT, with a stored rejectionReason)
 * should be rewritten IN PLACE using the reason — not discarded. We assert the
 * prompt carries the previous draft + reason, the draft is overwritten, the
 * preview gate is reset, and the consumed reason is cleared. Bad states (no
 * reason, wrong status, Gemini failure) behave safely.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  GenerationService,
  buildRegenerationPrompt,
} from '../src/content/generationService';
import type { AiPromptContextReader, PromptInputs } from '../src/content/generationService';
import type { ContentGenerator } from '../src/strategy/personaService';
import { ValidationError } from '../src/infra/errors';

const REVISED = JSON.stringify({
  title: 'Tiêu đề mềm mại hơn',
  body: 'Nội dung đã được viết lại nhẹ nhàng, gần gũi hơn theo góp ý.',
  ctas: ['Liên hệ tư vấn ngay'],
});

class CapturingGemini implements ContentGenerator {
  lastPrompt = '';
  constructor(private readonly response: string) {}
  async generateContent(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return this.response;
  }
}

class ThrowingGemini implements ContentGenerator {
  async generateContent(): Promise<string> {
    throw new Error('AI_DOWN');
  }
}

const emptyReader: AiPromptContextReader = { get: async () => null };

interface DraftRow {
  id: string;
  status: string;
  title: string;
  body: string;
  objective: string;
  rejectionReason: string | null;
  previewPresented: boolean;
  generatedWithoutFeedback: boolean;
  domainId: string;
  personaId: string;
}

/**
 * In-memory Prisma fake for regenerateFromRejection. Captures the update args
 * and the deleteMany calls so the test can assert the in-place overwrite.
 */
function makePrisma(seed: DraftRow): {
  prisma: PrismaClient;
  state: { row: DraftRow; lastUpdate?: Record<string, unknown>; ctaDeletes: number };
} {
  const state = { row: { ...seed }, lastUpdate: undefined as Record<string, unknown> | undefined, ctaDeletes: 0 };

  const prisma = {
    contentDraft: {
      findUnique: async () => ({
        ...state.row,
        ctas: [{ ctaText: 'CTA cũ' }],
        domain: {
          id: state.row.domainId,
          domainName: 'xkld-nhat-ban',
          contextDescription: 'XKLĐ Nhật Bản.',
          defaultToneOfVoice: 'thân thiện',
        },
        persona: {
          id: state.row.personaId,
          personaName: 'Nam',
          age: '20-26',
          targetNeeds: 'tìm đơn hàng',
          painPoints: 'sợ lừa đảo',
          toneOfVoice: 'thân thiện',
          recommendedTone: null,
        },
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        state.lastUpdate = args.data;
        state.row = {
          ...state.row,
          title: (args.data.title as string) ?? state.row.title,
          body: (args.data.body as string) ?? state.row.body,
          status: (args.data.status as string) ?? state.row.status,
          previewPresented: (args.data.previewPresented as boolean) ?? state.row.previewPresented,
          rejectionReason:
            args.data.rejectionReason === undefined
              ? state.row.rejectionReason
              : (args.data.rejectionReason as string | null),
        };
        return { ...state.row, ctas: [] };
      },
    },
    draftCta: {
      deleteMany: async () => {
        state.ctaDeletes += 1;
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaClient;

  return { prisma, state };
}

function seedDraft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: 'draft-1',
    status: 'DRAFT',
    title: 'Tiêu đề cũ',
    body: 'Nội dung cũ hơi cứng.',
    objective: 'Lead',
    rejectionReason: 'Giọng văn hơi cứng, cần mềm mại hơn',
    previewPresented: true,
    generatedWithoutFeedback: false,
    domainId: 'dom-1',
    personaId: 'per-1',
    ...over,
  };
}

describe('buildRegenerationPrompt', () => {
  it('includes the base prompt, the previous draft, and the rejection reason', () => {
    const inputs: PromptInputs = {
      domainName: 'xkld-nhat-ban',
      domainContext: 'XKLĐ Nhật Bản.',
      personaSummaries: ['Nam (age 20-26)'],
      toneOfVoice: 'thân thiện',
      objective: 'Lead',
    };
    const prompt = buildRegenerationPrompt(
      inputs,
      { title: 'Cũ', body: 'Thân bài cũ', ctas: ['CTA cũ'] },
      'Cần mềm mại hơn',
      null,
    );
    expect(prompt).toContain('[ExpertRole]');
    expect(prompt).toContain('[PreviousDraft]');
    expect(prompt).toContain('Thân bài cũ');
    expect(prompt).toContain('[RejectionReason]');
    expect(prompt).toContain('Cần mềm mại hơn');
    // The JSON/CTA instruction from the base prompt is still present.
    expect(prompt).toContain('[RequiredCTA]');
  });
});

describe('GenerationService.regenerateFromRejection', () => {
  it('rewrites the draft in place using the stored rejection reason', async () => {
    const { prisma, state } = makePrisma(seedDraft());
    const gemini = new CapturingGemini(REVISED);
    const service = new GenerationService(prisma, gemini, emptyReader);

    const result = await service.regenerateFromRejection('draft-1');

    // Prompt carried the previous body + the reason.
    expect(gemini.lastPrompt).toContain('Nội dung cũ hơi cứng.');
    expect(gemini.lastPrompt).toContain('Giọng văn hơi cứng, cần mềm mại hơn');

    // Draft overwritten in place, preview reset, reason cleared, still DRAFT.
    expect(result.draft.title).toBe('Tiêu đề mềm mại hơn');
    expect(state.ctaDeletes).toBe(1);
    expect(state.lastUpdate?.previewPresented).toBe(false);
    expect(state.lastUpdate?.rejectionReason).toBeNull();
    expect(state.lastUpdate?.status).toBe('DRAFT');
  });

  it('uses an override reason when provided', async () => {
    const { prisma } = makePrisma(seedDraft({ rejectionReason: null }));
    const gemini = new CapturingGemini(REVISED);
    const service = new GenerationService(prisma, gemini, emptyReader);

    await service.regenerateFromRejection('draft-1', 'Thêm số liệu cụ thể');
    expect(gemini.lastPrompt).toContain('Thêm số liệu cụ thể');
  });

  it('rejects when there is no reason (stored or override) with 400', async () => {
    const { prisma } = makePrisma(seedDraft({ rejectionReason: null }));
    const service = new GenerationService(prisma, new CapturingGemini(REVISED), emptyReader);
    await expect(service.regenerateFromRejection('draft-1')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects regenerating a non-DRAFT draft with 400', async () => {
    const { prisma } = makePrisma(seedDraft({ status: 'APPROVED' }));
    const service = new GenerationService(prisma, new CapturingGemini(REVISED), emptyReader);
    await expect(service.regenerateFromRejection('draft-1')).rejects.toBeInstanceOf(ValidationError);
  });

  it('persists nothing and surfaces the error when Gemini fails', async () => {
    const { prisma, state } = makePrisma(seedDraft());
    const service = new GenerationService(prisma, new ThrowingGemini(), emptyReader);
    await expect(service.regenerateFromRejection('draft-1')).rejects.toThrow();
    // No update/delete happened (Gemini threw before persistence).
    expect(state.lastUpdate).toBeUndefined();
    expect(state.ctaDeletes).toBe(0);
  });
});
