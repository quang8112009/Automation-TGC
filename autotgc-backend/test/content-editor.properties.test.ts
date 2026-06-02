/**
 * Property + unit tests for the Content_Editor rubric and EditorAgent
 * (proposal 3.4 — Multi-Agent Team).
 *
 * The pure `reviewDraft` rubric must never produce NaN, always clamp the score
 * to [0,100], always flag MISSING_CTA (error) iff there is no non-blank CTA, and
 * only PASS when score >= threshold AND there is no error-severity issue. The
 * EditorAgent must succeed and fall back to the deterministic summary when its
 * optional Gemini seam throws.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  reviewDraft,
  countCtas,
  PASS_THRESHOLD,
} from '../src/agents/contentEditor';
import { EditorAgent } from '../src/agents/editorAgent';
import type { ContentGenerator } from '../src/strategy/personaService';

describe('reviewDraft — properties', () => {
  it('score is always finite and within [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.array(fc.string()),
        fc.option(fc.constantFrom('Lead', 'View', 'Follow'), { nil: undefined }),
        (title, body, ctas, objective) => {
          const { score } = reviewDraft({ title, body, ctas, objective });
          expect(Number.isFinite(score)).toBe(true);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('MISSING_CTA (error) is present iff there is no non-blank CTA', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.array(fc.string()), (title, body, ctas) => {
        const review = reviewDraft({ title, body, ctas });
        const hasMissingCta = review.issues.some((i) => i.code === 'MISSING_CTA');
        expect(hasMissingCta).toBe(countCtas(ctas) === 0);
      }),
      { numRuns: 300 },
    );
  });

  it('verdict PASS implies score >= threshold AND no error-severity issue', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.array(fc.string()),
        (title, body, ctas) => {
          const review = reviewDraft({ title, body, ctas });
          if (review.verdict === 'PASS') {
            expect(review.score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
            expect(review.issues.some((i) => i.severity === 'error')).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('reviewDraft — concrete examples', () => {
  it('a solid draft with a CTA passes', () => {
    const review = reviewDraft({
      title: 'Cơ hội việc làm tại Nhật Bản 2025',
      body:
        'Đơn hàng kỹ năng đặc định ngành cơ khí, lương ổn định. Liên hệ hotline để được tư vấn ' +
        'miễn phí và đăng ký ngay hôm nay.',
      ctas: ['Đăng ký tư vấn'],
      objective: 'Lead',
      toneOfVoice: 'thân thiện',
    });
    expect(review.verdict).toBe('PASS');
    expect(review.issues.some((i) => i.code === 'MISSING_CTA')).toBe(false);
  });

  it('an empty, CTA-less draft is REVISE with a MISSING_CTA error', () => {
    const review = reviewDraft({ title: '', body: '', ctas: [] });
    expect(review.verdict).toBe('REVISE');
    const missing = review.issues.find((i) => i.code === 'MISSING_CTA');
    expect(missing?.severity).toBe('error');
  });
});

describe('EditorAgent.run', () => {
  const baseVars = {
    title: 'Cơ hội việc làm tại Nhật Bản 2025',
    body:
      'Đơn hàng kỹ năng đặc định ngành cơ khí. Liên hệ hotline để được tư vấn miễn phí và đăng ký.',
    ctas: ['Đăng ký tư vấn'],
    objective: 'Lead',
    toneOfVoice: 'thân thiện',
  };

  it('returns ok:true with editor outputs (no Gemini)', async () => {
    const agent = new EditorAgent();
    const result = await agent.run({ runId: 'r1', variables: baseVars });
    expect(result.ok).toBe(true);
    expect(result.output?.editorVerdict).toBe('PASS');
    expect(typeof result.output?.editorScore).toBe('number');
    expect(typeof result.output?.editorSummary).toBe('string');
  });

  it('uses a Gemini summary when the seam returns text', async () => {
    const gemini: ContentGenerator = {
      generateContent: async () => 'Nhận xét AI: nội dung tốt, nên thêm số liệu cụ thể.',
    };
    const agent = new EditorAgent(gemini);
    const result = await agent.run({ runId: 'r1', variables: baseVars });
    expect(result.ok).toBe(true);
    expect(result.output?.editorSummary).toContain('Nhận xét AI');
  });

  it('falls back to the deterministic summary when Gemini throws', async () => {
    const gemini: ContentGenerator = {
      generateContent: async () => {
        throw new Error('AI_NOT_CONFIGURED');
      },
    };
    const agent = new EditorAgent(gemini);
    const result = await agent.run({ runId: 'r1', variables: baseVars });
    expect(result.ok).toBe(true);
    expect(typeof result.output?.editorSummary).toBe('string');
    expect((result.output?.editorSummary as string).length).toBeGreaterThan(0);
  });
});
