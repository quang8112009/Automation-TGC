import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../src/auth/jwt';
import {
  buildPrompt,
  isPerformanceContextComplete,
  parseGeneratedContent,
  GenerationService,
} from '../src/content/generationService';
import type {
  AiPromptContextReader,
  PerformanceContext,
  PromptInputs,
} from '../src/content/generationService';
import type { ContentGenerator } from '../src/strategy/personaService';
import {
  evaluatePlatformGate,
  draftDescriptionLength,
  TIKTOK_MAX_DESCRIPTION,
} from '../src/content/schedulingService';
import { CalendarService, colorFor } from '../src/content/calendarService';
import type { ContentStatus } from '../src/content/stateMachine';

// ---- Test doubles -----------------------------------------------------------

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

/** Captures the last prompt passed to the model and returns a canned response. */
class CapturingGemini implements ContentGenerator {
  lastPrompt = '';
  constructor(private readonly response: string) {}
  async generateContent(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return this.response;
  }
}

const CANNED_CONTENT = JSON.stringify({
  title: 'A Title',
  body: 'A body of content.',
  ctas: ['Buy now', 'Learn more'],
});

/** Minimal Prisma fake for GenerationService.generate. */
function fakeGenerationPrisma(): { prisma: PrismaClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    domainContext: {
      findUnique: async () => ({
        id: 'dom-1',
        domainName: 'Coffee Shop',
        contextDescription: 'Local artisan coffee.',
        defaultToneOfVoice: 'friendly',
      }),
    },
    contentPersona: {
      findMany: async () => [
        {
          id: 'per-1',
          personaName: 'Busy Professional',
          age: '25-40',
          interests: 'productivity',
          targetNeeds: 'quick caffeine',
          painPoints: 'no time',
          toneOfVoice: 'energetic',
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

/** Prisma fake for CalendarService.reschedule with a configurable stored post. */
function fakeReschedulePrisma(post: { id: string; status: string; scheduledAt: Date } | null): {
  prisma: PrismaClient;
  updates: Array<{ id: string; scheduledAt: Date }>;
} {
  const updates: Array<{ id: string; scheduledAt: Date }> = [];
  const prisma = {
    scheduledPost: {
      findUnique: async () => post,
      update: async (args: { where: { id: string }; data: { scheduledAt: Date } }) => {
        updates.push({ id: args.where.id, scheduledAt: args.data.scheduledAt });
        return { id: args.where.id, scheduledAt: args.data.scheduledAt };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, updates };
}

// ---- Generators -------------------------------------------------------------

const objectiveArb = fc.constantFrom('Lead', 'View', 'Follow' as const);

const promptInputsArb: fc.Arbitrary<PromptInputs> = fc.record({
  domainName: fc.string({ minLength: 1, maxLength: 20 }),
  domainContext: fc.string({ maxLength: 30 }),
  personaSummaries: fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 1, maxLength: 3 }),
  toneOfVoice: fc.string({ minLength: 1, maxLength: 15 }),
  objective: objectiveArb,
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

describe('content-pipeline generation', () => {
  // Feature: content-pipeline, Property 1: Gemini prompt segment ordering
  it('Property 1: buildPrompt emits segments in fixed order with required-CTA always last', () => {
    fc.assert(
      fc.property(promptInputsArb, fc.option(completeCtxArb, { nil: null }), (inputs, ctx) => {
        const prompt = buildPrompt(inputs, ctx);
        const order = [
          '[ExpertRole]',
          '[DomainContext]',
          '[Persona]',
          '[Tone]',
          '[Objective]',
        ];
        const positions = order.map((tag) => prompt.indexOf(tag));
        // All mandatory segments present and strictly increasing in order.
        for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
        for (let i = 1; i < positions.length; i++) {
          expect(positions[i]).toBeGreaterThan(positions[i - 1]);
        }
        // Required-CTA instruction is ALWAYS present and last.
        const ctaPos = prompt.indexOf('[RequiredCTA]');
        expect(ctaPos).toBeGreaterThan(positions[positions.length - 1]);
        const perfPos = prompt.indexOf('[PerformanceContext]');
        if (isPerformanceContextComplete(ctx)) {
          // Present and strictly between objective and required-CTA.
          expect(perfPos).toBeGreaterThan(positions[positions.length - 1]);
          expect(ctaPos).toBeGreaterThan(perfPos);
        } else {
          expect(perfPos).toBe(-1);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: content-pipeline, Property 2: Cold-start generation fallback
  it('Property 2: cold-start marks generatedWithoutFeedback, persists >=1 CTA, omits performance segment', async () => {
    await fc.assert(
      fc.asyncProperty(incompleteCtxArb, async (ctx) => {
        const { prisma, created } = fakeGenerationPrisma();
        const gemini = new CapturingGemini(CANNED_CONTENT);
        const reader: AiPromptContextReader = { get: async () => ctx };
        const service = new GenerationService(prisma, gemini, reader);

        const result = await service.generate({
          domainName: 'Coffee Shop',
          personaIds: ['per-1'],
          objective: 'Lead',
        });

        // Cold start: no performance feedback applied.
        expect(result.generatedWithoutFeedback).toBe(true);
        // Performance segment omitted from the prompt.
        expect(gemini.lastPrompt.indexOf('[PerformanceContext]')).toBe(-1);
        // A draft was persisted with >=1 CTA.
        expect(created).toHaveLength(1);
        const data = created[0] as { generatedWithoutFeedback: boolean; ctas: { create: unknown[] } };
        expect(data.generatedWithoutFeedback).toBe(true);
        expect(data.ctas.create.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: content-pipeline, Property 2: Cold-start generation fallback (complete context path)
  it('Property 2: a complete performance context clears generatedWithoutFeedback and includes the segment', async () => {
    await fc.assert(
      fc.asyncProperty(completeCtxArb, async (ctx) => {
        const { prisma, created } = fakeGenerationPrisma();
        const gemini = new CapturingGemini(CANNED_CONTENT);
        const reader: AiPromptContextReader = { get: async () => ctx };
        const service = new GenerationService(prisma, gemini, reader);

        const result = await service.generate({
          domainName: 'Coffee Shop',
          personaIds: ['per-1'],
          objective: 'View',
        });

        expect(result.generatedWithoutFeedback).toBe(false);
        expect(gemini.lastPrompt.indexOf('[PerformanceContext]')).toBeGreaterThanOrEqual(0);
        const data = created[0] as { generatedWithoutFeedback: boolean };
        expect(data.generatedWithoutFeedback).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: content-pipeline, Property 2: Generation output shape (>=1 CTA invariant)
  it('Property 2: parseGeneratedContent always yields a title, body, and >=1 CTA', () => {
    const contentArb = fc.record({
      title: fc.string({ minLength: 1, maxLength: 30 }),
      body: fc.string({ minLength: 1, maxLength: 60 }),
      ctas: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 4 }),
    });
    fc.assert(
      fc.property(contentArb, (content) => {
        const parsed = parseGeneratedContent(JSON.stringify(content));
        expect(parsed.title.length).toBeGreaterThan(0);
        expect(parsed.body.length).toBeGreaterThan(0);
        expect(parsed.ctas.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});

describe('content-pipeline scheduling gates', () => {
  // Feature: content-pipeline, Property 3: Scheduling validation per platform
  it('Property 3: per-platform gate enforces future time and TikTok media/length', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('facebook', 'tiktok', 'website' as const),
        fc.integer({ min: -1_000_000, max: 1_000_000 }), // ms offset from now
        fc.boolean(), // hasTikTokMedia
        fc.integer({ min: 0, max: 4000 }), // descriptionLength
        (platform, offsetMs, hasTikTokMedia, descriptionLength) => {
          const now = new Date('2025-01-01T00:00:00.000Z');
          const scheduledAt = new Date(now.getTime() + offsetMs);
          const result = evaluatePlatformGate({
            platform,
            scheduledAt,
            now,
            hasTikTokMedia,
            descriptionLength,
          });

          const future = scheduledAt.getTime() > now.getTime();
          let expectedOk = future;
          if (platform === 'tiktok') {
            expectedOk = future && hasTikTokMedia && descriptionLength < TIKTOK_MAX_DESCRIPTION;
          }
          expect(result.ok).toBe(expectedOk);

          if (!result.ok) {
            // Failures carry a code identifying the failing gate.
            if (!future) {
              expect(result.code).toBe('NOT_FUTURE');
            } else if (platform === 'tiktok' && !hasTikTokMedia) {
              expect(result.code).toBe('TIKTOK_MEDIA_REQUIRED');
            } else if (platform === 'tiktok') {
              expect(result.code).toBe('TIKTOK_DESCRIPTION_TOO_LONG');
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: content-pipeline, Property 3: TikTok length boundary uses the strict < 2200 rule
  it('Property 3: a TikTok description of exactly 2200 chars is rejected; 2199 is accepted', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2195, max: 2205 }), (len) => {
        const now = new Date('2025-01-01T00:00:00.000Z');
        const result = evaluatePlatformGate({
          platform: 'tiktok',
          scheduledAt: new Date(now.getTime() + 60_000),
          now,
          hasTikTokMedia: true,
          descriptionLength: len,
        });
        expect(result.ok).toBe(len < TIKTOK_MAX_DESCRIPTION);
      }),
      { numRuns: 100 },
    );
  });

  it('draftDescriptionLength joins body + CTAs', () => {
    expect(draftDescriptionLength('ab', ['cd'])).toBe('ab\n\ncd'.length);
    expect(draftDescriptionLength('', [])).toBe(0);
  });
});

describe('content-pipeline calendar', () => {
  // Feature: content-pipeline, Property 4: Reschedule validity (drag-and-drop)
  it('Property 4: reschedule succeeds iff status is SCHEDULED and the new time is strictly future', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('SCHEDULED', 'PUBLISHED', 'DRAFT', 'PUBLISHING', 'FAILED' as ContentStatus),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        async (status, offsetMs) => {
          const now = new Date('2025-06-01T00:00:00.000Z');
          const original = new Date('2025-06-02T00:00:00.000Z');
          const { prisma, updates } = fakeReschedulePrisma({ id: 'sp-1', status, scheduledAt: original });
          const service = new CalendarService(prisma, fixedClock(now));
          const newTime = new Date(now.getTime() + offsetMs);

          const future = newTime.getTime() > now.getTime();
          const shouldSucceed = status === 'SCHEDULED' && future;

          let ok = false;
          try {
            await service.reschedule('sp-1', newTime);
            ok = true;
          } catch {
            ok = false;
          }

          expect(ok).toBe(shouldSucceed);
          if (shouldSucceed) {
            expect(updates).toHaveLength(1);
            expect(updates[0].scheduledAt.getTime()).toBe(newTime.getTime());
          } else {
            // No write occurs on rejection (time unchanged).
            expect(updates).toHaveLength(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: content-pipeline, Property 5: Calendar status colors are distinct (injective)
  it('Property 5: colorFor is injective over {SCHEDULED, PUBLISHED, DRAFT, FAILED}', () => {
    const statuses: ContentStatus[] = ['SCHEDULED', 'PUBLISHED', 'DRAFT', 'FAILED'];
    fc.assert(
      fc.property(
        fc.constantFrom(...statuses),
        fc.constantFrom(...statuses),
        (a, b) => {
          if (a === b) {
            expect(colorFor(a)).toBe(colorFor(b));
          } else {
            expect(colorFor(a)).not.toBe(colorFor(b));
          }
        },
      ),
      { numRuns: 100 },
    );
    // Exhaustive distinctness check.
    const colors = statuses.map(colorFor);
    expect(new Set(colors).size).toBe(statuses.length);
  });
});
