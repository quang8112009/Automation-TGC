/**
 * Shared secret-leak guard for AI prompts.
 *
 * Every prompt builder that forwards user/candidate-derived text to an external
 * AI text/embedding provider should run `assertNoSecrets` on the final prompt
 * BEFORE it leaves the process. This guarantees a secret-like value (a private
 * key, a provider API key, an explicit `apiKey=`/`secret=` assignment) is never
 * transmitted to a third-party gateway — and the request fails loudly rather
 * than the value being silently sent.
 *
 * Originally this logic lived only in `interviewprep/interviewAgent.ts`. It is
 * extracted here so every agent (consultant, essay writer, visa advisor,
 * roadmap narrative, grounded assistant, …) shares ONE conservative detector.
 *
 * The patterns mirror the deny-set in `scripts/secret-scan.js`: private-key
 * headers, common provider API-key prefixes/tokens, and explicit
 * `apiKey=`/`secret=` assignments. The guard is intentionally conservative — it
 * errs toward failing a suspicious prompt rather than silently leaking a secret.
 *
 * Pure & deterministic so it can be exhaustively property-tested.
 */
import { ValidationError } from './errors';

/** Secret-shaped patterns. Conservative: prefer a false positive over a leak. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/, // Google API key shape
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style secret key
  /\b(?:api[_-]?key|secret|access[_-]?token|bearer)\b\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}/i,
];

/**
 * Throw a 400 `ValidationError` if `text` contains a secret-like value.
 *
 * @param text the fully-assembled prompt about to be sent to a provider.
 * @param code error code to surface (defaults to a generic
 *   `PROMPT_SECRET_DETECTED`); callers may pass a module-specific code so the
 *   client can tell which builder rejected the input.
 */
export function assertNoSecrets(text: string, code = 'PROMPT_SECRET_DETECTED'): void {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      throw new ValidationError(
        'Refusing to send a prompt that appears to contain a secret value',
        code,
      );
    }
  }
}
