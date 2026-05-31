/**
 * Pure registration/login validation (Foundation Req 1, 2.6).
 * Separated from I/O so it is property-testable.
 */

export interface RegisterInput {
  username?: string;
  email?: string;
  password?: string;
  passwordConfirmation?: string;
}

export type ValidationOk = { ok: true };
export type ValidationFail = { ok: false; status: 400; code: string; message: string };
export type ValidationResult = ValidationOk | ValidationFail;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistration(input: RegisterInput): ValidationResult {
  const email = input.email ?? '';
  // Req 1.2: email format + length
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, status: 400, code: 'INVALID_EMAIL', message: 'A valid email is required.' };
  }
  const password = input.password ?? '';
  // Req 1.3: password length 8..128
  if (password.length < 8 || password.length > 128) {
    return { ok: false, status: 400, code: 'INVALID_PASSWORD', message: 'Password must be 8 to 128 characters.' };
  }
  // Req 1.4: confirmation match
  if (password !== (input.passwordConfirmation ?? '')) {
    return { ok: false, status: 400, code: 'PASSWORD_MISMATCH', message: 'Passwords do not match.' };
  }
  const username = input.username ?? '';
  // Req 1.5: username non-blank, not whitespace-only, <= 50
  if (username.trim().length === 0 || username.length > 50) {
    return { ok: false, status: 400, code: 'INVALID_USERNAME', message: 'A username of 1 to 50 non-blank characters is required.' };
  }
  return { ok: true };
}

export interface LoginInput {
  username?: string;
  password?: string;
}

export function validateLoginShape(input: LoginInput): ValidationResult {
  // Req 2.6: empty username or password -> 400
  if (!input.username || input.username.length === 0) {
    return { ok: false, status: 400, code: 'MISSING_USERNAME', message: 'Username is required.' };
  }
  if (!input.password || input.password.length === 0) {
    return { ok: false, status: 400, code: 'MISSING_PASSWORD', message: 'Password is required.' };
  }
  return { ok: true };
}
