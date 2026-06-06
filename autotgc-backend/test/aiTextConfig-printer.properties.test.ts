/**
 * Property-based tests for the Pretty_Printer of the deepseek-v4-model-migration
 * spec — `printAiTextConfig` / `parsePrintedAiTextConfig` in
 * `src/infra/aiTextConfig.ts`.
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: deepseek-v4-model-migration, Property {N}: {property_text}`) and
 * runs >= 100 generated cases on fast-check (R7.1). The logic under test is pure
 * and framework-free, so no fakes/mocks are required.
 *
 * Generators intentionally exercise the robustness of the line-oriented format:
 * the printer emits one `key=value` line per property joined by `\n`, and the
 * reader splits each line on the FIRST `=`. So values may contain `=`, spaces,
 * query strings and Unicode and still round-trip — the only character that would
 * break the framing is a newline, which is excluded from generated values.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  printAiTextConfig,
  parsePrintedAiTextConfig,
} from '../src/infra/aiTextConfig';
import type { AiTextConfig } from '../src/infra/aiTextConfig';

// --- generators --------------------------------------------------------------

/**
 * Strip the only character that would break the `\n`-joined line framing. A
 * newline inside a value would otherwise inject a spurious "line" that the
 * reader could mis-parse as another `key=value` pair. `\r` is stripped too so
 * the round-trip is platform-agnostic.
 */
const stripLineBreaks = (s: string): string => s.replace(/[\r\n]/g, '');

/**
 * Non-empty, single-line string mixing ASCII, full Unicode, and values that
 * deliberately contain `=` and spaces — so the first-`=` split is stressed.
 */
const lineSafeNonEmpty: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 24 }),
    fc.fullUnicodeString({ minLength: 1, maxLength: 24 }),
    fc
      .tuple(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }))
      .map(([a, b]) => `${a}=${b} value`),
  )
  .map(stripLineBreaks)
  .filter((s) => s.length > 0);

/** A `key=value&...` query string whose parts themselves contain `=`. */
const queryStringArb: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.string({ maxLength: 6 })),
    { maxLength: 4 },
  )
  .map((pairs) => pairs.map(([k, v]) => `${k}=${v}`).join('&'));

/**
 * baseUrl generator biased toward URLs that include `=` and query strings
 * (e.g. `https://host/v1?x=1`) plus arbitrary single-line strings. No literal
 * dotted-quad hosts are used so the repo secret-scan stays clean.
 */
const baseUrlArb: fc.Arbitrary<string> = fc
  .oneof(
    lineSafeNonEmpty,
    fc
      .tuple(
        fc.constantFrom(
          'https://host/v1',
          'https://gateway.example/v1',
          'http://localhost:8080/v1',
          'https://api.deepseek.example/v1',
        ),
        queryStringArb,
      )
      .map(([base, qs]) => (qs.length > 0 ? `${base}?${qs}` : base)),
  )
  .map(stripLineBreaks)
  .filter((s) => s.length > 0);

/** Finite, positive timeout `>= 100` (integers and doubles). */
const timeoutArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 100, max: 1_000_000_000 }),
  fc.double({ min: 100, max: 1_000_000_000, noNaN: true, noDefaultInfinity: true }),
);

/** A valid `AiTextConfig` (exactly the four normalized properties). */
const configArb: fc.Arbitrary<AiTextConfig> = fc.record({
  provider: lineSafeNonEmpty,
  baseUrl: baseUrlArb,
  model: lineSafeNonEmpty,
  timeout: timeoutArb,
});

/**
 * An API-key-shaped secret token: a non-trivial run from the realistic key
 * charset `[A-Za-z0-9_-]` (optionally `sk-` prefixed). It contains no `=`,
 * space, or newline, so it can never coincide with the printer's fixed
 * `key=` vocabulary (`provider=`, `baseUrl=`, ...). Length >= 16 makes a
 * coincidental substring of a config value astronomically unlikely; a `fc.pre`
 * guard handles the residual case so the test never flakes.
 */
const secretToken: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
    ),
    { minLength: 16, maxLength: 64 },
  )
  .map((cs) => cs.join(''));
const apiKeyArb: fc.Arbitrary<string> = fc.oneof(
  secretToken,
  secretToken.map((t) => `sk-${t}`),
);

// --- tests -------------------------------------------------------------------

describe('deepseek-v4-model-migration Pretty_Printer properties', () => {
  // Feature: deepseek-v4-model-migration, Property 11: Round-trip in→đọc cấu hình
  // For any valid AiTextConfig c, parsePrintedAiTextConfig(printAiTextConfig(c))
  // deep-equals c on all four properties {provider, baseUrl, model, timeout}.
  // Validates: Requirements 6.3
  it('Property 11: parsePrintedAiTextConfig(printAiTextConfig(c)) deep-equals c', () => {
    fc.assert(
      fc.property(configArb, (config) => {
        const printed = printAiTextConfig(config);
        const parsed = parsePrintedAiTextConfig(printed);
        expect(parsed).toEqual(config);
      }),
      { numRuns: 100 },
    );
  });

  // Explicit anchor for the documented edge case: a baseUrl that itself
  // contains `=` and a query string must survive the first-`=` split.
  it('Property 11 (anchor): round-trips a baseUrl with `=` and a query string', () => {
    const config: AiTextConfig = {
      provider: 'deepseek',
      baseUrl: 'https://host/v1?x=1&y=a=b',
      model: 'deepseek-v4-flash',
      timeout: 20_000,
    };
    expect(parsePrintedAiTextConfig(printAiTextConfig(config))).toEqual(config);
  });

  // Feature: deepseek-v4-model-migration, Property 7: Không lộ bí mật trong đầu ra
  // (part (a)) For any AiTextConfig and any apiKey value, the text produced by
  // printAiTextConfig does NOT contain the apiKey as a substring — the config
  // carries no secret field, so the printer can never emit one.
  // Validates: Requirements 2.6, 6.2
  it('Property 7(a): printed config never contains the apiKey value', () => {
    fc.assert(
      fc.property(configArb, apiKeyArb, (config, apiKey) => {
        // Guard the non-leak case where the user themselves placed the token
        // verbatim inside a NON-secret config value (not a printer leak). The
        // \u0000 separators (impossible in the key charset) keep the check from
        // matching across value boundaries.
        const values = `${config.provider}\u0000${config.baseUrl}\u0000${config.model}\u0000${config.timeout}`;
        fc.pre(!values.includes(apiKey));

        const printed = printAiTextConfig(config);
        expect(printed.includes(apiKey)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
