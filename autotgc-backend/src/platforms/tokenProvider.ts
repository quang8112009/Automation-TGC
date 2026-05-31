/**
 * Token provider seam consumed by platform adapters.
 *
 * Adapters never read the Secret_Store directly; they ask an injected provider
 * for the current token value for their platform. The Token_Manager implements
 * this interface. This keeps adapters decoupled from config/secret plumbing and
 * trivially mockable in tests.
 */
import { AppError } from '../infra/errors';
import type { PlatformId } from './adapter';

export interface PlatformTokenProvider {
  /**
   * The configured token value for a platform, or undefined when no usable
   * token is present (missing or a placeholder). Never returns a placeholder.
   */
  getTokenValue(platform: PlatformId): string | undefined;
}

/** Sentinel values that indicate an unconfigured/placeholder secret. */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'todo',
  'replace_me',
  'replace-me',
  'xxx',
  'none',
  'null',
  'undefined',
]);

/**
 * A token value is "usable" when it is a non-empty, non-placeholder string.
 */
export function isUsableTokenValue(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !PLACEHOLDER_VALUES.has(trimmed.toLowerCase());
}

/**
 * Resolve a usable token or fail with a clear 502 (Req: external integrations
 * report a configuration error rather than emitting a misleading platform
 * response when credentials are absent in Phase 1).
 */
export function requireToken(
  provider: PlatformTokenProvider,
  platform: PlatformId,
): string {
  const value = provider.getTokenValue(platform);
  if (!isUsableTokenValue(value)) {
    throw new AppError(502, `Platform "${platform}" is not configured`, 'PLATFORM_NOT_CONFIGURED');
  }
  return value;
}
