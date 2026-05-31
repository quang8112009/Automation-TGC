import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateCreateLead, resolveFacebookAttribution, resolveWebsiteAttribution, validateDateRange, LEAD_SOURCES, LEAD_PLATFORMS, UNATTRIBUTED } from '../src/leads/validation';
import { verifySignature, computeSignature } from '../src/infra/hmac';
import { createSecretLoader } from '../src/infra/secrets';
import { isUpcoming, isDataStale } from '../src/dashboard/helpers';

describe('lead-management-dashboard', () => {
  // Feature: lead-management-dashboard, Property 18: webhook source & content attribution
  it('Property 18: website attribution sets tiktok_bio iff utm_source=tiktok_bio', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), fc.option(fc.string({ minLength: 1 }), { nil: undefined }), (utm, cpid) => {
        const a = resolveWebsiteAttribution(utm, cpid);
        expect(a.platform).toBe('website');
        expect(a.source).toBe(utm === 'tiktok_bio' ? 'tiktok_bio' : 'website_form');
        if (cpid && cpid.trim().length > 0) {
          expect(a.contentPostId).toBe(cpid);
          expect(a.unattributed).toBe(false);
        } else {
          expect(a.contentPostId).toBe(UNATTRIBUTED);
          expect(a.unattributed).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('facebook attribution is fixed', () => {
    const a = resolveFacebookAttribution('POST-1');
    expect(a.source).toBe('facebook_leadgen');
    expect(a.platform).toBe('facebook');
  });

  // Feature: lead-management-dashboard, Property 2/3/4: create validation
  it('Property 2-4: create validation', () => {
    fc.assert(
      fc.property(
        fc.record({
          phone: fc.option(fc.string(), { nil: undefined }),
          email: fc.option(fc.string(), { nil: undefined }),
          source: fc.constantFrom(...LEAD_SOURCES, 'bogus'),
          platform: fc.constantFrom(...LEAD_PLATFORMS, 'bogus'),
          contentPostId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        }),
        (input) => {
          const r = validateCreateLead(input, true);
          const hasContact = (input.phone && input.phone.trim()) || (input.email && input.email.trim());
          if (!hasContact) {
            expect(r.ok).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: lead-management-dashboard, Property 8: date-range validation
  it('Property 8: from > to rejected', () => {
    expect(validateDateRange('2026-02-01', '2026-01-01').ok).toBe(false);
    expect(validateDateRange('2026-01-01', '2026-02-01').ok).toBe(true);
    expect(validateDateRange(undefined, undefined).ok).toBe(true);
  });

  // Feature: lead-management-dashboard, Property 26: upcoming 7-day window
  it('Property 26: upcoming window predicate', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(isUpcoming(new Date('2026-06-03T00:00:00Z'), now)).toBe(true);
    expect(isUpcoming(new Date('2026-06-09T00:00:00Z'), now)).toBe(false); // > 7 days
    expect(isUpcoming(new Date('2026-05-31T00:00:00Z'), now)).toBe(false); // past
    expect(isUpcoming(new Date('2026-06-08T00:00:00Z'), now)).toBe(true); // exactly 7 days
  });

  // Feature: lead-management-dashboard, Property 28: staleness predicate
  it('Property 28: data sync staleness', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    expect(isDataStale(new Date('2026-06-01T05:00:00Z'), now, 6)).toBe(true); // 7h old
    expect(isDataStale(new Date('2026-06-01T06:00:00Z'), now, 6)).toBe(false); // exactly 6h = current
    expect(isDataStale(null, now, 6)).toBe(true);
  });
});

describe('foundation infra', () => {
  // Feature: foundation-and-deployment, Property 18: webhook HMAC gate
  it('Property 18: HMAC verify accepts correct, rejects tampered', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 8 }), (body, secret) => {
        const sig = computeSignature(secret, body);
        expect(verifySignature(secret, body, sig)).toBe(true);
        expect(verifySignature(secret, body + 'x', sig)).toBe(false);
        expect(verifySignature(secret, body, sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a'))).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property 16: secret redaction
  it('Property 16: secret values never appear in redacted output', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8 }), fc.string(), (secret, prefix) => {
        const loader = createSecretLoader({ MY_TOKEN: secret });
        const line = `${prefix} token=${secret} end`;
        const out = loader.redact(line);
        expect(out.includes(secret)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
