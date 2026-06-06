// Feature: frontend-ui-redesign, Property 4: error classification preserves code and message
/**
 * Property 4 — classifyError mapping. Validates Requirements 8.3, 8.4.
 *
 * For all ApiError{status,code,message}:
 *   - status === 502 ⇒ { kind:'notice',    code, message }
 *   - otherwise       ⇒ { kind:'error-box', code, message }
 *   both carry code AND message.
 * For non-ApiError values:
 *   - a real Error    ⇒ { kind:'error-box', message: error.message } (no code)
 *   - any other value ⇒ { kind:'error-box', message: String(value) } (no code)
 * Pure, deterministic, total — never throws.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classifyError } from '../src/lib/errors';
import { ApiError } from '../src/lib/apiClient';

// HTTP statuses the backend is allowed to emit (plus 502 for the notice branch).
const arbStatus = fc.constantFrom(200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502);

const arbApiError = fc
  .record({ status: arbStatus, code: fc.string(), message: fc.string() })
  .map(({ status, code, message }) => new ApiError(status, code, message));

describe('Property 4: classifyError mapping', () => {
  it('maps ApiError by status while preserving code + message', () => {
    fc.assert(
      fc.property(arbApiError, (err) => {
        const view = classifyError(err);
        expect(view.kind).toBe(err.status === 502 ? 'notice' : 'error-box');
        expect(view.code).toBe(err.code);
        expect(view.message).toBe(err.message);
        // Determinism: same input → equal result.
        expect(classifyError(err)).toEqual(view);
      }),
      { numRuns: 200 },
    );
  });

  it('maps a non-ApiError Error to an error-box carrying its message and no code', () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        const view = classifyError(new Error(message));
        expect(view.kind).toBe('error-box');
        expect(view.message).toBe(message);
        expect(view.code).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it('maps arbitrary non-Error values to an error-box with a string message, never throwing', () => {
    // Safe stringification oracle: String(value) itself throws on pathological
    // objects (e.g. { toString: false }), so the expected message falls back to
    // a string when coercion is impossible — mirroring classifyError's totality.
    const safeString = (value: unknown): string => {
      try {
        return String(value);
      } catch {
        return 'Đã xảy ra lỗi không xác định.';
      }
    };
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.object(),
        ),
        (value) => {
          const view = classifyError(value);
          expect(view.kind).toBe('error-box');
          expect(view.code).toBeUndefined();
          expect(typeof view.message).toBe('string');
          expect(view.message).toBe(safeString(value));
        },
      ),
      { numRuns: 200 },
    );
  });
});
