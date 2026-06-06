/**
 * Property-based tests for the pure `extractText` helper of `AiTextClient`
 * (deepseek-v4-model-migration spec, task 2.2).
 *
 * `extractText(body)` bóc tách nội dung trợ lý từ shape OpenAI ChatCompletions
 * `{choices:[{message:{content}}]}`. Hai property của design được phủ tại đây:
 *   - Property 3 (chuỗi + ghép mảng) — Validates Requirements 1.2, 1.3, 7.2, 7.7
 *   - Property 5 (không có nội dung văn bản → undefined, nhánh extractText) —
 *     Validates Requirements 3.7, 7.8
 *
 * Mỗi property chạy fast-check với `{ numRuns: 100 }` (R7.1).
 *
 * NOTE — đã KIỂM CHỨNG hành vi chuỗi rỗng so với source thật:
 *   `asString` (src/platforms/narrow.ts) trả `undefined` cho chuỗi rỗng vì điều
 *   kiện `value.length > 0`. Do đó `extractText` với `content === ''` trả
 *   `undefined` (KHÔNG phải `''`). Điều này KHỚP với design Property 5 — không có
 *   sai lệch giữa source và design. Logic xử lý kết quả rỗng thành
 *   `AI_BAD_RESPONSE` nằm ở `generateContent` (task 2.3); ở đây chỉ kiểm
 *   `extractText` trả `undefined`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { extractText } from '../src/infra/aiTextClient';

// --- helpers ----------------------------------------------------------------

/** Bọc một giá trị `content` bất kỳ vào shape OpenAI ChatCompletions. */
function bodyWithContent(content: unknown): unknown {
  return { choices: [{ message: { content } }] };
}

/**
 * Reference/oracle ĐỘC LẬP cho nhánh ghép mảng (không dùng helper của source):
 * ghép, theo đúng thứ tự xuất hiện và KHÔNG chèn ký tự phân tách, trường `text`
 * của mỗi phần là object thuần có `text` kiểu chuỗi KHÔNG rỗng; bỏ qua mọi thứ
 * khác (phần không phải object, thiếu `text`, `text` rỗng, hoặc `text` không phải
 * chuỗi). Trả `undefined` nếu không có phần nào đóng góp.
 */
function referenceArrayJoin(parts: ReadonlyArray<unknown>): string | undefined {
  let acc = '';
  let contributed = false;
  for (const part of parts) {
    if (typeof part === 'object' && part !== null && !Array.isArray(part)) {
      const t = (part as Record<string, unknown>).text;
      if (typeof t === 'string' && t.length > 0) {
        acc += t;
        contributed = true;
      }
    }
  }
  return contributed ? acc : undefined;
}

// Chuỗi không rỗng, phủ ASCII + Unicode (incl. surrogate pairs).
const nonEmptyText = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.unicodeString({ minLength: 1 }),
  fc.fullUnicodeString({ minLength: 1 }),
);

// Giá trị `text` tùy ý cho một phần: chuỗi (incl. rỗng + Unicode), số, bool, vắng.
const arbitraryTextValue = fc.oneof(
  fc.string(),
  fc.unicodeString(),
  fc.constant(''),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(undefined),
);

// Một "phần" {type?, text?} với cả hai khóa đều có thể vắng mặt.
const partArb = fc.record(
  { type: fc.string(), text: arbitraryTextValue },
  { requiredKeys: [] },
);

// =============================================================================
// Property 3 — Bóc tách nội dung: chuỗi và ghép mảng
// =============================================================================

describe('deepseek-v4-model-migration — extractText (Property 3)', () => {
  // Feature: deepseek-v4-model-migration, Property 3: Bóc tách nội dung — chuỗi và ghép mảng
  // For any body where choices[0].message.content is a non-empty string, extractText returns that
  // exact string; and for any body where content is an array of parts, extractText returns the
  // concatenation (in appearance order, with NO separator) of exactly the non-empty string `text`
  // fields, skipping every part without a string `text`.
  // Validates: Requirements 1.2, 1.3, 7.2, 7.7

  it('Property 3a: non-empty string content → returns that exact string', () => {
    fc.assert(
      fc.property(nonEmptyText, (s) => {
        expect(extractText(bodyWithContent(s))).toBe(s);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 3b: array content → concatenation (no separator) of non-empty string text parts', () => {
    fc.assert(
      fc.property(fc.array(partArb, { maxLength: 12 }), (parts) => {
        const expected = referenceArrayJoin(parts);
        expect(extractText(bodyWithContent(parts))).toStrictEqual(expected);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 5 — Không có nội dung văn bản (nhánh extractText → undefined)
// =============================================================================

describe('deepseek-v4-model-migration — extractText (Property 5)', () => {
  // Feature: deepseek-v4-model-migration, Property 5: Phản hồi không có nội dung văn bản báo lỗi AI_BAD_RESPONSE
  // (extractText branch) For any body whose extraction yields no non-empty string — empty-string
  // content, a content array with no string `text` parts, missing content, or a body that is not the
  // expected shape — extractText returns undefined. (The thrown AI_BAD_RESPONSE lives in
  // generateContent, task 2.3.)
  // Validates: Requirements 3.7, 7.8

  // `text` values that NEVER yield a non-empty string (so a part never contributes).
  const nonStringOrEmptyText = fc.oneof(
    fc.constant(''),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(undefined),
    fc.constant(null),
  );
  const noTextPartArb = fc.record(
    { type: fc.string(), text: nonStringOrEmptyText },
    { requiredKeys: [] },
  );

  const noTextBody = fc.oneof(
    // empty-string content (verified: asString returns undefined → extractText undefined)
    fc.constant(bodyWithContent('')),
    // array whose parts can never produce a non-empty string text
    fc.array(noTextPartArb, { maxLength: 12 }).map(bodyWithContent),
    // missing content / malformed shapes / non-object bodies
    fc.constantFrom<unknown>(
      null,
      undefined,
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: null } }] },
      { choices: [{ message: { content: undefined } }] },
      { choices: 'nope' },
      { choices: {} },
      42,
      'a plain string body',
      [],
      [{ message: { content: 'ignored — not under choices.0' } }],
    ),
  );

  it('Property 5: no extractable text → undefined', () => {
    fc.assert(
      fc.property(noTextBody, (body) => {
        expect(extractText(body)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
