/**
 * Property-based tests for the deepseek-v4-model-migration spec — Property 8:
 * the AI-OPTIONAL invariant of grounded consumers is preserved after the
 * provider migration.
 *
 * Covered consumers (constructible without a DB — they take an injected
 * `ContentGenerator` seam plus plain context objects):
 *   - EssayWriter.write       (src/essays/essayWriter.ts)
 *   - RoadmapNarrative.narrate (src/roadmap/roadmapNarrative.ts)
 *
 * Consumers requiring a live Prisma client / KnowledgeService (consultantAgent,
 * interviewAgent, reportService, marketing services) are intentionally NOT
 * exercised here — they share the EXACT same try/catch → enforceAiGeneratedFlag
 * fallback discipline (verified in task 5.1) and are covered by their own
 * suites. The two consumers above are representative of the invariant.
 *
 * Invariant (Validates Req 3.1, 3.2, 3.5, 3.8, 7.4, 7.6): when the AI seam
 * throws ANY of AI_NOT_CONFIGURED / AI_REQUEST_FAILED / AI_BAD_RESPONSE, the
 * consumer resolves (never lets a 502 escape) with a deterministic fallback
 * whose `aiGenerated === false` and whose content field is non-empty; when the
 * seam returns non-empty text, the consumer uses it with `aiGenerated === true`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { AppError } from '../src/infra/errors';
import type { ContentGenerator } from '../src/strategy/personaService';
import { EssayWriter } from '../src/essays/essayWriter';
import type { EssayContext, EssayDocType } from '../src/essays/types';
import { RoadmapNarrative } from '../src/roadmap/roadmapNarrative';
import type { RoadmapEstimate } from '../src/roadmap/types';

// --- fake seams --------------------------------------------------------------

const AI_ERROR_CODES = ['AI_NOT_CONFIGURED', 'AI_REQUEST_FAILED', 'AI_BAD_RESPONSE'] as const;

/** A ContentGenerator that always throws one of the three internal 502s. */
function throwingSeam(code: (typeof AI_ERROR_CODES)[number]): ContentGenerator {
  return {
    async generateContent(): Promise<string> {
      throw new AppError(502, 'AI failure', code);
    },
  };
}

/** A ContentGenerator that returns a fixed non-empty string. */
function returningSeam(text: string): ContentGenerator {
  return {
    async generateContent(): Promise<string> {
      return text;
    },
  };
}

// --- generators --------------------------------------------------------------

const aiErrorCodeArb = fc.constantFrom(...AI_ERROR_CODES);
const nonEmptyAiText = fc.fullUnicodeString({ minLength: 1, maxLength: 80 }).map((s) => `AI:${s}`);

const docTypeArb: fc.Arbitrary<EssayDocType> = fc.constantFrom('SOP', 'MOTIVATION', 'CV');

const essayCtxArb: fc.Arbitrary<EssayContext> = fc.record({
  candidateName: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
  educationLevel: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
  programName: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
  programCountry: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
  fieldOfStudy: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
});

const metricArb: fc.Arbitrary<number | 'INSUFFICIENT_DATA'> = fc.oneof(
  fc.integer({ min: 0, max: 5000 }),
  fc.constant<'INSUFFICIENT_DATA'>('INSUFFICIENT_DATA'),
);

const estimateArb: fc.Arbitrary<RoadmapEstimate> = fc.record({
  netCostPerYearVndM: metricArb,
  totalCostVndM: metricArb,
  roi: metricArb,
  careerNotes: fc.array(fc.string({ maxLength: 30 }), { maxLength: 4 }),
  prPathwayNotes: fc.array(fc.string({ maxLength: 30 }), { maxLength: 4 }),
});

// --- tests -------------------------------------------------------------------

describe('deepseek-v4-model-migration Property 8 — consumer AI-OPTIONAL invariant', () => {
  // Feature: deepseek-v4-model-migration, Property 8: Bất biến AI-OPTIONAL của consumer
  // EssayWriter: seam throws (any AI 502) ⇒ deterministic fallback aiGenerated=false,
  // never throws; seam returns text ⇒ aiGenerated=true.
  // Validates: Requirements 3.1, 3.2, 3.5, 3.8, 7.4
  it('Property 8 (EssayWriter): seam failure ⇒ non-empty fallback, aiGenerated=false; success ⇒ true', async () => {
    await fc.assert(
      fc.asyncProperty(essayCtxArb, docTypeArb, aiErrorCodeArb, async (ctx, docType, code) => {
        // --- failure mode: any of the three AI errors ---
        const failWriter = new EssayWriter(throwingSeam(code));
        const failed = await failWriter.write(ctx, docType, 'AI');
        expect(failed.aiGenerated).toBe(false);
        expect(typeof failed.content).toBe('string');
        expect(failed.content.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 8 (EssayWriter): seam success ⇒ uses AI text with aiGenerated=true', async () => {
    await fc.assert(
      fc.asyncProperty(essayCtxArb, docTypeArb, nonEmptyAiText, async (ctx, docType, text) => {
        const writer = new EssayWriter(returningSeam(text));
        const out = await writer.write(ctx, docType, 'AI');
        expect(out.aiGenerated).toBe(true);
        expect(out.content).toBe(text.trim());
      }),
      { numRuns: 100 },
    );
  });

  it('Property 8 (EssayWriter): STRUCTURED mode is always deterministic fallback (aiGenerated=false)', async () => {
    await fc.assert(
      fc.asyncProperty(essayCtxArb, docTypeArb, nonEmptyAiText, async (ctx, docType, text) => {
        // Even with a working AI seam, STRUCTURED mode never marks AI-generated.
        const writer = new EssayWriter(returningSeam(text));
        const out = await writer.write(ctx, docType, 'STRUCTURED');
        expect(out.aiGenerated).toBe(false);
        expect(out.content.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 8: Bất biến AI-OPTIONAL của consumer
  // RoadmapNarrative: seam throws ⇒ deterministic narrative aiGenerated=false, never throws;
  // seam returns text ⇒ aiGenerated=true.
  // Validates: Requirements 3.1, 3.2, 3.5, 3.8, 7.4
  it('Property 8 (RoadmapNarrative): seam failure ⇒ non-empty fallback, aiGenerated=false', async () => {
    await fc.assert(
      fc.asyncProperty(estimateArb, aiErrorCodeArb, async (estimate, code) => {
        const narrator = new RoadmapNarrative(throwingSeam(code));
        const out = await narrator.narrate(estimate, []);
        expect(out.aiGenerated).toBe(false);
        expect(typeof out.text).toBe('string');
        expect(out.text.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 8 (RoadmapNarrative): seam success ⇒ uses AI text with aiGenerated=true', async () => {
    await fc.assert(
      fc.asyncProperty(estimateArb, nonEmptyAiText, async (estimate, text) => {
        const narrator = new RoadmapNarrative(returningSeam(text));
        const out = await narrator.narrate(estimate, []);
        expect(out.aiGenerated).toBe(true);
        expect(out.text).toBe(text.trim());
      }),
      { numRuns: 100 },
    );
  });

  it('Property 8: no seam configured ⇒ deterministic fallback (aiGenerated=false), never throws', async () => {
    await fc.assert(
      fc.asyncProperty(essayCtxArb, docTypeArb, estimateArb, async (ctx, docType, estimate) => {
        const essay = await new EssayWriter(undefined).write(ctx, docType, 'AI');
        expect(essay.aiGenerated).toBe(false);
        expect(essay.content.length).toBeGreaterThan(0);

        const roadmap = await new RoadmapNarrative(undefined).narrate(estimate, []);
        expect(roadmap.aiGenerated).toBe(false);
        expect(roadmap.text.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});
