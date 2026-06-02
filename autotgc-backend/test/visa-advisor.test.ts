/**
 * Tests for the VisaAdvisor (AI-grounded visa/logistics advice). Verifies the
 * deterministic advisory is grounded in the catalog + planner, Gemini phrasing
 * is used when available, and any Gemini failure falls back without throwing.
 */
import { describe, it, expect } from 'vitest';

import {
  VisaAdvisor,
  buildDeterministicAdvice,
  buildAdvicePrompt,
} from '../src/visa/visaAdvisor';
import type { ContentGenerator } from '../src/strategy/personaService';

describe('buildDeterministicAdvice', () => {
  it('lists urgent tasks + recommends OSHC for Australia', () => {
    const base = buildDeterministicAdvice({ country: 'AUSTRALIA' });
    expect(base.insuranceType).toBe('OSHC');
    expect(base.nextTasks.length).toBeGreaterThan(0);
    expect(base.advisory).toContain('AUSTRALIA');
  });

  it('includes ISO deadlines when a target intake date is given', () => {
    const target = new Date('2026-09-01T00:00:00.000Z');
    const base = buildDeterministicAdvice({ country: 'AUSTRALIA', targetIntakeDate: target });
    // At least one task should carry a "hạn ~ YYYY-MM-DD" marker.
    expect(base.nextTasks.some((t) => /hạn ~ \d{4}-\d{2}-\d{2}/.test(t))).toBe(true);
  });
});

describe('buildAdvicePrompt', () => {
  it('is grounded and instructs no fabrication', () => {
    const base = buildDeterministicAdvice({ country: 'UK' });
    const prompt = buildAdvicePrompt(base, 'UK');
    expect(prompt).toContain('KHÔNG bịa');
    expect(prompt).toContain(base.advisory);
  });
});

describe('VisaAdvisor.advise', () => {
  it('returns deterministic advice (aiGenerated:false) with no Gemini', async () => {
    const advisor = new VisaAdvisor();
    const advice = await advisor.advise({ country: 'CANADA' });
    expect(advice.aiGenerated).toBe(false);
    expect(advice.advisory.length).toBeGreaterThan(0);
  });

  it('uses Gemini phrasing when available (aiGenerated:true)', async () => {
    const gemini: ContentGenerator = {
      generateContent: async () => 'Tư vấn AI: hãy ưu tiên hộ chiếu và CoE trước.',
    };
    const advisor = new VisaAdvisor(gemini);
    const advice = await advisor.advise({ country: 'AUSTRALIA' });
    expect(advice.aiGenerated).toBe(true);
    expect(advice.advisory).toContain('Tư vấn AI');
  });

  it('falls back deterministically when Gemini throws', async () => {
    const gemini: ContentGenerator = {
      generateContent: async () => {
        throw new Error('AI_NOT_CONFIGURED');
      },
    };
    const advisor = new VisaAdvisor(gemini);
    const advice = await advisor.advise({ country: 'USA' });
    expect(advice.aiGenerated).toBe(false);
    expect(advice.advisory.length).toBeGreaterThan(0);
  });
});
