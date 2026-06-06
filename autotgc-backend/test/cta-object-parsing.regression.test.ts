/**
 * Regression: GEN_CTA_MISSING when the model returns CTA OBJECTS.
 *
 * deepseek-v4-flash returns `ctas` as an array of objects like
 *   { "text": "Đăng ký tư vấn", "url": "https://...", "type": "button" }
 * instead of plain strings. The old extractor called asString() on each element
 * (undefined for objects) → empty CTA array → spurious GEN_CTA_MISSING even
 * though the model DID provide CTAs. parseGeneratedContent + parseFormatContent
 * must now pull the label from common object fields.
 */
import { describe, it, expect } from 'vitest';
import { parseGeneratedContent } from '../src/content/generationService';
import { parseFormatContent } from '../src/marketing/content/multiFormatGenerator';

describe('CTA object parsing (GEN_CTA_MISSING regression)', () => {
  it('parseGeneratedContent accepts ctas as objects with a text field', () => {
    const text = JSON.stringify({
      title: 'Tiêu đề',
      body: 'Nội dung đầy đủ.',
      ctas: [
        { text: 'Đăng ký tư vấn', url: 'https://x.com/dk', type: 'button' },
        { text: 'Gọi ngay', url: 'tel:+84' },
      ],
    });
    const out = parseGeneratedContent(text);
    expect(out.ctas).toEqual(['Đăng ký tư vấn', 'Gọi ngay']);
  });

  it('parseGeneratedContent still accepts plain-string ctas', () => {
    const text = JSON.stringify({ title: 'T', body: 'B', ctas: ['Liên hệ ngay'] });
    expect(parseGeneratedContent(text).ctas).toEqual(['Liên hệ ngay']);
  });

  it('parseGeneratedContent supports alternative label fields (label/cta/title)', () => {
    const text = JSON.stringify({
      title: 'T',
      body: 'B',
      ctas: [{ label: 'Nhấn vào đây' }, { cta: 'Tìm hiểu thêm' }],
    });
    expect(parseGeneratedContent(text).ctas).toEqual(['Nhấn vào đây', 'Tìm hiểu thêm']);
  });

  it('parseGeneratedContent still throws GEN_CTA_MISSING when objects carry no label', () => {
    const text = JSON.stringify({
      title: 'T',
      body: 'B',
      ctas: [{ url: 'https://x', type: 'button' }],
    });
    expect(() => parseGeneratedContent(text)).toThrowError(/GEN_CTA_MISSING|CTA/);
  });

  it('parseFormatContent (SEO_ARTICLE) accepts CTA objects', () => {
    const text = JSON.stringify({
      title: 'Mức lương thực lãnh khi đi Nhật Bản',
      metaDescription: 'meta',
      body: '## H2\nNội dung.',
      ctas: [{ text: 'Đăng ký', url: 'https://x', type: 'button' }],
      keywords: ['lương nhật'],
    });
    const out = parseFormatContent('SEO_ARTICLE', text);
    expect(out.ctas).toEqual(['Đăng ký']);
    expect(out.keywords).toContain('lương nhật');
  });
});
