/**
 * Pure error-classification logic for the shared `ErrorMessage` component.
 *
 * This module is intentionally framework-free (no React) so the mapping from a
 * thrown value to a presentation variant can be imported and property-tested in
 * isolation (Design — Property 4). `ui.tsx`'s `ErrorMessage` consumes the
 * structured result and is the only place that renders it.
 *
 * Mapping rule (unchanged in intent from the previous inline logic):
 *   - `ApiError` with status 502 (an external service — AI / social platform —
 *     is not configured on the server) → a soft "notice" variant, still
 *     carrying both `code` and `message`.
 *   - any other `ApiError` → the "error-box" variant carrying `code` + `message`.
 *   - a non-`ApiError` value → the "error-box" variant carrying just `message`.
 */
import { ApiError } from './apiClient';

/** Presentation variant the error should render as. */
export type ErrorViewKind = 'notice' | 'error-box';

/**
 * Structured, deterministic description of how an error should be presented.
 * `code` is present only when the source was an `ApiError`.
 */
export interface ClassifiedError {
  kind: ErrorViewKind;
  code?: string;
  message: string;
}

/** HTTP status used by the backend when an external service is unconfigured. */
const SERVICE_UNCONFIGURED_STATUS = 502;

/** Fallback message when a thrown value cannot be coerced to a string. */
const UNKNOWN_ERROR_MESSAGE = 'Đã xảy ra lỗi không xác định.';

/**
 * Coerce an arbitrary value to a string without ever throwing.
 *
 * A thrown value can be anything in JavaScript, including a pathological object
 * whose `toString`/`valueOf` cannot produce a primitive (e.g. `{ toString: false }`),
 * for which `String(value)` throws `TypeError: Cannot convert object to primitive
 * value`. Since this runs on the error-rendering path, it must degrade gracefully
 * rather than throw a second error.
 */
function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }
}

/**
 * Classify an arbitrary thrown value into a structured, renderable result.
 *
 * Pure and total: never throws and never mutates its input. The same input
 * always yields an equal result, which is what the property test relies on.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof ApiError) {
    const kind: ErrorViewKind =
      error.status === SERVICE_UNCONFIGURED_STATUS ? 'notice' : 'error-box';
    return { kind, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : safeStringify(error);
  return { kind: 'error-box', message };
}
