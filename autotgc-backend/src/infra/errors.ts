/**
 * Centralized error taxonomy and response envelope.
 * Implements Foundation Requirement 19.1 (restricted status-code set).
 */

export type AllowedStatus =
  | 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 423 | 500 | 502;

export class AppError extends Error {
  constructor(
    public readonly status: AllowedStatus,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(400, message, code);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(401, message, code);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN') {
    super(403, message, code);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found', code = 'NOT_FOUND') {
    super(404, message, code);
  }
}
export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(409, message, code);
  }
}
export class LockedError extends AppError {
  constructor(message = 'Account locked', code = 'LOCKED') {
    super(423, message, code);
  }
}

export const ALLOWED_STATUS_CODES: ReadonlySet<number> = new Set([
  200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502,
]);

export interface ErrorBody {
  error: { code: string; message: string };
}

export function toErrorBody(err: unknown, redact: (s: string) => string): { status: AllowedStatus; body: ErrorBody } {
  if (err instanceof AppError) {
    return { status: err.status, body: { error: { code: err.code, message: redact(err.message) } } };
  }
  const msg = err instanceof Error ? err.message : 'Internal server error';
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: redact(msg) } } };
}
