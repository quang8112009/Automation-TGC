/**
 * Property-based tests for the document catalog (ai-reporting-and-ops-enhancements).
 *
 * Kept in a SEPARATE file from `ai-reporting-and-ops.properties.test.ts` to
 * avoid collisions while the other properties are implemented in parallel.
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: ai-reporting-and-ops-enhancements, Property {n}: {design text}`)
 * and runs >= 100 generated cases on fast-check.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  DEFAULT_DOC_CATALOG,
  defaultDocsForMarket,
} from '../src/recruitment/documents/documentCatalog';

/** Canonical supported market codes (RecruitmentMarket enum). */
const SUPPORTED_MARKETS = ['JAPAN', 'KOREA', 'GERMANY', 'TAIWAN', 'DOMESTIC', 'OTHER'] as const;

describe('documentCatalog — Property 15', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 15: Với mọi giá trị
  // `desiredMarket` là null hoặc không thuộc tập `Market` hỗ trợ,
  // `defaultDocsForMarket` trả về đúng bộ giấy tờ mặc định của thị trường `OTHER`.
  // Validates: Requirements 12.3
  it('returns exactly the OTHER set for null/undefined/unknown markets', () => {
    const otherSet = DEFAULT_DOC_CATALOG.OTHER;

    // Generators: null, undefined, and arbitrary strings that are NOT supported
    // market codes (covers the "unknown market" input space intelligently).
    const unsupportedMarket = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc
        .string()
        .filter((s) => !(SUPPORTED_MARKETS as readonly string[]).includes(s)),
    );

    fc.assert(
      fc.property(unsupportedMarket, (market) => {
        const docs = defaultDocsForMarket(market as string | null | undefined);

        // Must equal the OTHER set exactly (same length, same ordered content).
        expect(docs).toEqual(Array.from(otherSet));
      }),
      { numRuns: 200 },
    );
  });
});
