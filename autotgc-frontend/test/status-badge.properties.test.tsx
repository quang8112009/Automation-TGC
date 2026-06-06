// Feature: frontend-ui-redesign, Property 3: StatusBadge is total and never colour-only
/**
 * Property 3 — StatusBadge totality. Validates Requirements 5.6, 9.6.
 *
 * For all strings (incl. empty / garbage) and all known status keys,
 * `statusBadgeClass` returns one of {badge-gray,green,red,blue,yellow},
 * defaulting to badge-gray. The rendered <StatusBadge> always shows the textual
 * `status` label (state is never conveyed by colour alone) and carries a
 * `"badge " + <valid class>` className.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { StatusBadge, statusBadgeClass } from '../src/components/ui';

afterEach(() => cleanup());

const VALID = ['badge-gray', 'badge-green', 'badge-red', 'badge-blue', 'badge-yellow'];

// Known status keys mapped explicitly in STATUS_CLASS (a representative set).
const KNOWN_STATUSES = [
  'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED',
  'FAILED', 'NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST', 'RUNNING',
  'WAITING_APPROVAL', 'COMPLETED', 'CANCELLED', 'PENDING', 'DONE', 'SKIPPED',
  'VALID', 'MISSING', 'REFRESH_FAILED', 'CURRENT', 'STALE',
];

// Mix arbitrary strings (garbage / empty) with the known status keys.
const arbStatus = fc.oneof(fc.string(), fc.constantFrom(...KNOWN_STATUSES));

describe('Property 3: StatusBadge totality + non-colour-only', () => {
  it('statusBadgeClass is total and only ever returns a valid badge class', () => {
    fc.assert(
      fc.property(arbStatus, (status) => {
        const cls = statusBadgeClass(status);
        expect(VALID).toContain(cls);
        // Unknown / empty statuses default to badge-gray.
        if (!KNOWN_STATUSES.includes(status)) {
          expect(cls).toBe('badge-gray');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('renders the textual label and a "badge <valid class>" className', () => {
    fc.assert(
      fc.property(arbStatus, (status) => {
        const { container } = render(<StatusBadge status={status} />);
        const el = container.querySelector('span.badge');
        expect(el).not.toBeNull();
        if (!el) return;

        // className is exactly "badge " + a valid colour class.
        const classes = Array.from(el.classList);
        expect(classes).toContain('badge');
        const colour = classes.find((c) => c.startsWith('badge-'));
        expect(colour).toBeDefined();
        expect(VALID).toContain(colour);
        expect(el.className).toBe(`badge ${statusBadgeClass(status)}`);

        // The textual status is always rendered (not colour-only). For an empty
        // status there is no text to show, but the label still equals `status`.
        expect(el.textContent).toBe(status);

        cleanup();
      }),
      { numRuns: 200 },
    );
  });
});
