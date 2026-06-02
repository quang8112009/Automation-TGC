/**
 * Document-checklist pure validation/narrowing helpers (Requirements 11.3,
 * 13.1, 13.2).
 *
 * Kept pure (no Prisma/Fastify) so they can be unit/property tested directly
 * and reused by both `documentChecklistService` and the route layer. Mirrors
 * the style of `recruitment/validation.ts` (small `is*` membership checks) and
 * the `asString`/`asInt`-type narrowing helpers used in `recruitment/routes.ts`
 * and `platforms/narrow.ts`. Throws typed `ValidationError` (HTTP 400) on
 * invalid input, matching the project's error taxonomy.
 */
import { ValidationError } from '../../infra/errors';
import type { DocSubmissionStatus } from './documentCatalog';

/** The four valid document submission statuses (mirrors the Prisma enum). */
export const DOC_SUBMISSION_STATUSES: readonly DocSubmissionStatus[] = [
  'PENDING',
  'SUBMITTED',
  'VERIFIED',
  'REJECTED',
];

/** True when a string is undefined/null/whitespace-only. */
export function blank(v: string | null | undefined): boolean {
  return v === undefined || v === null || v.trim().length === 0;
}

/** Narrow an unknown value to a non-empty string, else undefined. */
export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Narrow an unknown value to a boolean, accepting JSON-ish string forms. */
export function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Type guard: is the value one of the four valid submission statuses? */
export function isDocSubmissionStatus(v: unknown): v is DocSubmissionStatus {
  return typeof v === 'string' && (DOC_SUBMISSION_STATUSES as readonly string[]).includes(v);
}

/**
 * Assert that a custom item label is non-blank after trimming, returning the
 * trimmed label. Blank (undefined/null/whitespace-only) → `ValidationError`
 * (HTTP 400). (Requirements 13.1, 13.2)
 */
export function assertNonBlankLabel(label: string | null | undefined): string {
  if (blank(label)) {
    throw new ValidationError('label is required', 'DOC_LABEL_REQUIRED');
  }
  return (label as string).trim();
}

/**
 * Assert that a submission status is one of the four valid enum values,
 * returning it narrowed. Any other value → `ValidationError` (HTTP 400).
 * (Requirements 11.3, 13.3)
 */
export function assertValidStatus(status: unknown): DocSubmissionStatus {
  if (!isDocSubmissionStatus(status)) {
    throw new ValidationError(
      `Invalid document status: ${String(status)}`,
      'INVALID_DOC_STATUS',
    );
  }
  return status;
}
