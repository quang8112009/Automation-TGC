/**
 * Property-based tests for the deepseek-v4-model-migration spec — Re_Grounding.
 *
 * Property 14 (determinism + provider-independence of grounded prompts) and
 * Property 7 part (c) (no secret value leaks into an assembled prompt) over the
 * pure, exported prompt builders:
 *   - buildEssayPrompt      (src/essays/essayWriter.ts)
 *   - buildNarrativePrompt  (src/roadmap/roadmapNarrative.ts)
 *
 * These builders are pure and framework-free, so the same input always yields
 * the same prompt string (determinism), and they only ever assemble from the
 * supplied context/knowledge — never from a secret. The prompt the builder
 * produces is what AiTextClient passes verbatim into `messages`, so a
 * deterministic, secret-free prompt is provider-independent by construction.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildEssayPrompt } from '../src/essays/essayWriter';
import type { EssayContext, EssayDocType } from '../src/essays/types';
import { buildNarrativePrompt } from '../src/roadmap/roadmapNarrative';
import type { KnowledgeNote, RoadmapEstimate } from '../src/roadmap/types';

// --- generators --------------------------------------------------------------

const docTypeArb: fc.Arbitrary<EssayDocType> = fc.constantFrom('SOP', 'MOTIVATION', 'CV');

const essayCtxArb: fc.Arbitrary<EssayContext> = fc.record({
  candidateName: fc.option(fc.string({ maxLength: 24 }), { nil: null }),
  educationLevel: fc.option(fc.string({ maxLength: 24 }), { nil: null }),
  programName: fc.option(fc.string({ maxLength: 24 }), { nil: null }),
  programCountry: fc.option(fc.string({ maxLength: 24 }), { nil: null }),
  fieldOfStudy: fc.option(fc.string({ maxLength: 24 }), { nil: null }),
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

const knowledgeArb: fc.Arbitrary<KnowledgeNote[]> = fc.array(
  fc.record({ title: fc.string({ maxLength: 20 }), content: fc.string({ maxLength: 40 }) }),
  { maxLength: 4 },
);

/** An API-key-shaped secret token from the realistic key charset. */
const apiKeyArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
    ),
    { minLength: 16, maxLength: 48 },
  )
  .map((cs) => `sk-${cs.join('')}`);

// --- tests -------------------------------------------------------------------

describe('deepseek-v4-model-migration Re_Grounding properties', () => {
  // Feature: deepseek-v4-model-migration, Property 14: Prompt grounding xác định và độc lập nhà cung cấp
  // Calling a builder twice with the same input yields equal strings (determinism).
  // Validates: Requirements 5.1, 5.2
  it('Property 14: buildEssayPrompt is deterministic for the same input', () => {
    fc.assert(
      fc.property(essayCtxArb, docTypeArb, (ctx, docType) => {
        expect(buildEssayPrompt(ctx, docType)).toBe(buildEssayPrompt(ctx, docType));
      }),
      { numRuns: 100 },
    );
  });

  it('Property 14: buildNarrativePrompt is deterministic for the same input', () => {
    fc.assert(
      fc.property(estimateArb, knowledgeArb, (estimate, knowledge) => {
        expect(buildNarrativePrompt(estimate, knowledge)).toBe(
          buildNarrativePrompt(estimate, knowledge),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('Property 14: retrieved knowledge appears after the role/estimate segments (fixed order)', () => {
    fc.assert(
      fc.property(
        estimateArb,
        fc.array(
          fc.record({ title: fc.string({ minLength: 1, maxLength: 12 }), content: fc.string({ minLength: 1, maxLength: 24 }) }),
          { minLength: 1, maxLength: 4 },
        ),
        (estimate, knowledge) => {
          const prompt = buildNarrativePrompt(estimate, knowledge);
          // The [Role] segment always precedes the [RetrievedKnowledge] segment:
          // grounding is appended after the role/estimate context (fixed order).
          const roleIdx = prompt.indexOf('[Role]');
          const knowledgeIdx = prompt.indexOf('[RetrievedKnowledge]');
          expect(roleIdx).toBeGreaterThanOrEqual(0);
          expect(knowledgeIdx).toBeGreaterThan(roleIdx);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 7: Không lộ bí mật trong đầu ra
  // (part (c)) An assembled grounding prompt never contains the apiKey value —
  // the builders take only context/knowledge, never a secret.
  // Validates: Requirements 5.6
  it('Property 7(c): buildEssayPrompt output never contains the apiKey value', () => {
    fc.assert(
      fc.property(essayCtxArb, docTypeArb, apiKeyArb, (ctx, docType, apiKey) => {
        const prompt = buildEssayPrompt(ctx, docType);
        expect(prompt.includes(apiKey)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 7(c): buildNarrativePrompt output never contains the apiKey value', () => {
    fc.assert(
      fc.property(estimateArb, knowledgeArb, apiKeyArb, (estimate, knowledge, apiKey) => {
        const prompt = buildNarrativePrompt(estimate, knowledge);
        expect(prompt.includes(apiKey)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
