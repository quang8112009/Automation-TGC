// Feature: frontend-ui-redesign, Property 2: Icon honours the a11y + stroke contract
/**
 * Property 2 — Icon a11y/stroke contract. Validates Requirements 12.3, 12.4.
 *
 * For every name ∈ ICON_NAMES, with and without a non-empty title, the rendered
 * root <svg> always has stroke="currentColor", fill="none",
 * viewBox="0 0 24 24", stroke-width="1.75" (default). A non-empty title ⇒
 * role="img", aria-label === title and a <title> child; no/empty title ⇒
 * aria-hidden="true", no aria-label, no role. No render throws.
 *
 * Renders the real component via @testing-library/react under jsdom.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { Icon, ICON_NAMES } from '../src/components/Icon';

afterEach(() => cleanup());

const arbName = fc.constantFrom(...ICON_NAMES);
// title: undefined / empty string (both decorative) / a non-empty label.
const arbTitle = fc.option(fc.string(), { nil: undefined });

describe('Property 2: Icon a11y + stroke contract', () => {
  it('always renders the stroke contract and the correct a11y branch', () => {
    fc.assert(
      fc.property(arbName, arbTitle, (name, title) => {
        const { container } = render(<Icon name={name} title={title} />);
        const svg = container.querySelector('svg');
        expect(svg).not.toBeNull();
        if (!svg) return;

        // Stroke contract — invariant for every icon, regardless of title.
        expect(svg.getAttribute('stroke')).toBe('currentColor');
        expect(svg.getAttribute('fill')).toBe('none');
        expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
        expect(svg.getAttribute('stroke-width')).toBe('1.75');

        const labelled = typeof title === 'string' && title.length > 0;
        if (labelled) {
          expect(svg.getAttribute('role')).toBe('img');
          expect(svg.getAttribute('aria-label')).toBe(title);
          expect(svg.getAttribute('aria-hidden')).toBeNull();
          const titleEl = svg.querySelector('title');
          expect(titleEl).not.toBeNull();
          expect(titleEl?.textContent).toBe(title);
        } else {
          expect(svg.getAttribute('aria-hidden')).toBe('true');
          expect(svg.getAttribute('aria-label')).toBeNull();
          expect(svg.getAttribute('role')).toBeNull();
          expect(svg.querySelector('title')).toBeNull();
        }

        cleanup();
      }),
      { numRuns: 200 },
    );
  });
});
