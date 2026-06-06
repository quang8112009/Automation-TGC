/**
 * Tests for the API/worker process split helpers:
 *  - parseRunMode: maps RUN_MODE env to the allowed set, defaulting to 'all'.
 *  - applyConnectionLimit: appends ?connection_limit= to DATABASE_URL only for a
 *    positive integer, never duplicating an existing limit, preserving the URL
 *    otherwise.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseRunMode } from '../src/infra/config';
import { applyConnectionLimit } from '../src/infra/prisma';

describe('parseRunMode', () => {
  it('recognizes api / worker (case + whitespace tolerant)', () => {
    expect(parseRunMode('api')).toBe('api');
    expect(parseRunMode('  API ')).toBe('api');
    expect(parseRunMode('worker')).toBe('worker');
    expect(parseRunMode('WORKER')).toBe('worker');
  });

  it('defaults to all for unset/unknown values', () => {
    for (const v of [undefined, '', '   ', 'all', 'nonsense', 'apiworker']) {
      expect(parseRunMode(v)).toBe('all');
    }
  });
});

describe('applyConnectionLimit', () => {
  it('appends connection_limit for a positive integer', () => {
    expect(applyConnectionLimit('postgresql://h/db?schema=public', '10')).toBe(
      'postgresql://h/db?schema=public&connection_limit=10',
    );
    expect(applyConnectionLimit('postgresql://h/db', '5')).toBe(
      'postgresql://h/db?connection_limit=5',
    );
  });

  it('leaves the URL untouched for missing/invalid limits', () => {
    const url = 'postgresql://h/db?schema=public';
    for (const bad of [undefined, '', '0', '-3', '1.5', 'abc']) {
      expect(applyConnectionLimit(url, bad)).toBe(url);
    }
  });

  it('does not duplicate an existing connection_limit', () => {
    const url = 'postgresql://h/db?connection_limit=3';
    expect(applyConnectionLimit(url, '10')).toBe(url);
  });

  it('returns undefined when the URL is undefined', () => {
    expect(applyConnectionLimit(undefined, '10')).toBeUndefined();
  });

  it('property: a valid positive-integer limit always yields exactly one connection_limit param', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('postgresql://h/db', 'postgresql://h/db?schema=public'),
        fc.integer({ min: 1, max: 200 }),
        (base, n) => {
          const out = applyConnectionLimit(base, String(n))!;
          const matches = out.match(/connection_limit=/g) ?? [];
          expect(matches).toHaveLength(1);
          expect(out).toContain(`connection_limit=${n}`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
