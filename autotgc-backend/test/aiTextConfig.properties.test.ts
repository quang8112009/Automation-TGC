/**
 * Property-based tests for the deepseek-v4-model-migration spec — Config_Parser.
 *
 * Covers the `parseAiTextConfig` (Config_Parser) properties from design.md:
 *   - Property 1  (Req 6.1)       valid raw config -> ok:true, EXACTLY four keys
 *   - Property 2  (Req 2.3, 6.4)  timeout normalization
 *   - Property 10 (Req 6.5)       reject invalid config + name the bad key
 *   - Property 12 (Req 2.2)       model default / verbatim passthrough
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: deepseek-v4-model-migration, Property {N}: {text}`) and runs
 * >= 100 generated cases on fast-check. The module under test is pure, so no
 * fakes/mocks are required. Constants are imported from the module rather than
 * hardcoded so the tests track the source of truth.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  parseAiTextConfig,
  AI_TEXT_DEFAULT_MODEL,
  AI_TEXT_DEFAULT_TIMEOUT_MS,
  AI_TEXT_MIN_TIMEOUT_MS,
} from '../src/infra/aiTextConfig';
import type { RawAiTextConfig } from '../src/infra/aiTextConfig';

// --- shared generators -------------------------------------------------------

// Whitespace characters that `String.prototype.trim()` strips (including the
// Unicode ones: NBSP, line/paragraph separators, ideographic space). A string
// built only from these has `.trim().length === 0` and must be treated as blank.
const WHITESPACE_CHARS = [' ', '\t', '\n', '\r', '\f', '\v', '\u00A0', '\u2028', '\u2029', '\u3000'];

/** Strings whose `.trim()` is empty: '' plus whitespace-only (incl. Unicode). */
const blankString: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...WHITESPACE_CHARS),
  { minLength: 0, maxLength: 6 },
);

/**
 * Strings guaranteed to have at least one non-whitespace character, so
 * `.trim().length > 0`. Wraps a non-blank core in arbitrary (possibly Unicode,
 * possibly whitespace) padding to exercise verbatim-passthrough + trimming.
 */
const nonBlankString: fc.Arbitrary<string> = fc
  .tuple(
    fc.fullUnicodeString({ maxLength: 8 }),
    fc.constantFrom('a', 'x', 'Z', '9', '-', 'é', '文', 'Ω'),
    fc.fullUnicodeString({ maxLength: 8 }),
  )
  .map(([pre, core, post]) => pre + core + post);

/**
 * A wide timeout generator spanning every shape the parser must normalize:
 * finite positive/negative numbers, 0, NaN, +/-Infinity, numeric strings
 * (incl. whitespace-padded, hex, exponent), non-numeric strings, Unicode, and
 * absent (undefined).
 */
const timeoutArb: fc.Arbitrary<string | number | undefined> = fc.oneof(
  fc.double(), // finite values, plus NaN and +/-Infinity by default
  fc.integer(),
  fc.integer({ min: 100, max: 600_000 }), // bias toward the valid range
  fc.integer({ min: 0, max: 99 }), // below the minimum threshold
  fc.constantFrom<number>(NaN, Infinity, -Infinity, 0, -1, 99, 100, 20_000, 100.5),
  fc.integer({ min: -1000, max: 600_000 }).map((n) => String(n)), // numeric strings
  fc.float({ noDefaultInfinity: true }).map((n) => String(n)),
  fc.integer({ min: 0, max: 600_000 }).map((n) => `  ${n} `), // whitespace-padded numeric
  fc.constantFrom('abc', '', '   ', 'NaN', '1e3', '0x10', '12px', '✓', '一二三', '12,34', '+50', '-200'),
  fc.fullUnicodeString({ maxLength: 10 }),
  fc.constant(undefined),
);

/**
 * Oracle for timeout normalization, framed exactly as Property 2: derive the
 * numeric interpretation of the raw input, then a value is kept IFF it is a
 * finite number `> 0` and `>= AI_TEXT_MIN_TIMEOUT_MS`; otherwise the default.
 */
function expectedTimeout(raw: string | number | undefined): number {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return AI_TEXT_DEFAULT_TIMEOUT_MS;
    value = Number(trimmed);
  } else {
    return AI_TEXT_DEFAULT_TIMEOUT_MS;
  }
  if (Number.isFinite(value) && value > 0 && value >= AI_TEXT_MIN_TIMEOUT_MS) {
    return value;
  }
  return AI_TEXT_DEFAULT_TIMEOUT_MS;
}

const EXPECTED_CONFIG_KEYS = ['baseUrl', 'model', 'provider', 'timeout'];

// =============================================================================
// Config_Parser properties
// =============================================================================

describe('deepseek-v4-model-migration properties (Config_Parser)', () => {
  // Feature: deepseek-v4-model-migration, Property 1: Config hợp lệ tạo đối tượng đúng bốn thuộc tính
  // For any valid raw config (non-empty baseUrl and non-empty model), parseAiTextConfig
  // returns ok:true with an AiTextConfig having EXACTLY {provider, baseUrl, model, timeout}
  // — no extra keys, no missing keys.
  it('Property 1: valid raw config yields ok:true with exactly the four keys', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }), // provider: arbitrary / absent / blank
        nonBlankString, // baseUrl (valid)
        nonBlankString, // model (valid)
        timeoutArb,
        (provider, baseUrl, model, timeout) => {
          const raw: RawAiTextConfig = { provider, baseUrl, model, timeout };
          const result = parseAiTextConfig(raw);

          expect(result.ok).toBe(true);
          if (!result.ok) return; // type-narrow; unreachable when ok
          // EXACTLY the four keys — guards against extra or missing properties.
          expect(Object.keys(result.config).sort()).toEqual(EXPECTED_CONFIG_KEYS);
          // Required values are carried through verbatim.
          expect(result.config.baseUrl).toBe(baseUrl);
          expect(result.config.model).toBe(model);
          // Provider + timeout are always present and well-typed.
          expect(typeof result.config.provider).toBe('string');
          expect(result.config.provider.length).toBeGreaterThan(0);
          expect(typeof result.config.timeout).toBe('number');
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 2: Chuẩn hóa timeout
  // For any timeout input (finite positive/negative number, 0, NaN, Infinity, numeric
  // string, non-numeric string, or absent), the resulting AiTextConfig.timeout equals the
  // input IFF it is a finite number > 0 and >= 100; in every other case it equals 20000.
  it('Property 2: timeout is normalized — kept iff finite >0 and >=100, else default', () => {
    fc.assert(
      fc.property(nonBlankString, nonBlankString, timeoutArb, (baseUrl, model, timeout) => {
        const result = parseAiTextConfig({ baseUrl, model, timeout });
        // baseUrl + model are valid, so the parse always succeeds.
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const expected = expectedTimeout(timeout);
        expect(result.config.timeout).toBe(expected);

        // Structural invariant: the normalized timeout is always a finite number
        // at or above the minimum threshold, never NaN/Infinity/<=0.
        expect(Number.isFinite(result.config.timeout)).toBe(true);
        expect(result.config.timeout).toBeGreaterThanOrEqual(AI_TEXT_MIN_TIMEOUT_MS);

        // The "kept iff valid" direction stated explicitly: when the numeric
        // interpretation is valid the value is preserved; otherwise it is the default.
        const numeric = typeof timeout === 'number'
          ? timeout
          : typeof timeout === 'string' && timeout.trim() !== ''
            ? Number(timeout.trim())
            : NaN;
        const valid = Number.isFinite(numeric) && numeric > 0 && numeric >= AI_TEXT_MIN_TIMEOUT_MS;
        if (valid) {
          expect(result.config.timeout).toBe(numeric);
        } else {
          expect(result.config.timeout).toBe(AI_TEXT_DEFAULT_TIMEOUT_MS);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 10: Từ chối cấu hình không hợp lệ và chỉ rõ khóa sai
  // For any raw config with absent/empty/whitespace baseUrl, parseAiTextConfig returns
  // ok:false with invalidKey === 'baseUrl'; for a valid baseUrl with an explicitly-provided
  // empty/whitespace model, it returns ok:false with invalidKey === 'model'. It never
  // returns a config object missing properties.
  it('Property 10: absent/blank baseUrl is rejected as invalidKey "baseUrl"', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), blankString), // absent / empty / whitespace
        fc.option(nonBlankString, { nil: undefined }), // model: any (irrelevant; baseUrl fails first)
        timeoutArb,
        (baseUrl, model, timeout) => {
          const result = parseAiTextConfig({ baseUrl, model, timeout });
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.invalidKey).toBe('baseUrl');
          // No partial config is ever produced on the error path.
          expect('config' in result).toBe(false);
          expect(typeof result.message).toBe('string');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 10: valid baseUrl with explicit blank model is rejected as invalidKey "model"', () => {
    fc.assert(
      fc.property(
        nonBlankString, // valid baseUrl so model is reached
        blankString, // explicitly-provided '' or whitespace-only model (never undefined)
        timeoutArb,
        (baseUrl, model, timeout) => {
          const result = parseAiTextConfig({ baseUrl, model, timeout });
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.invalidKey).toBe('model');
          expect('config' in result).toBe(false);
          expect(typeof result.message).toBe('string');
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: deepseek-v4-model-migration, Property 12: Mặc định model
  // For any valid raw config whose model is absent, AiTextConfig.model === 'deepseek-v4-flash';
  // for any non-empty model provided, AiTextConfig.model equals that string verbatim.
  it('Property 12: absent model defaults to deepseek-v4-flash', () => {
    fc.assert(
      fc.property(nonBlankString, timeoutArb, (baseUrl, timeout) => {
        const result = parseAiTextConfig({ baseUrl, timeout }); // model intentionally absent
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.model).toBe(AI_TEXT_DEFAULT_MODEL);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 12: a provided non-empty model is used verbatim', () => {
    fc.assert(
      fc.property(nonBlankString, nonBlankString, timeoutArb, (baseUrl, model, timeout) => {
        const result = parseAiTextConfig({ baseUrl, model, timeout });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.model).toBe(model);
        expect(result.config.model).not.toBe('');
      }),
      { numRuns: 200 },
    );
  });
});
