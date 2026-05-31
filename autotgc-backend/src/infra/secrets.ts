/**
 * Config / Secret loader with fail-fast and redaction.
 * Implements Foundation Requirements 13.1–13.4.
 */

export class MissingSecretError extends Error {
  constructor(public readonly secretName: string) {
    // Log the NAME only, never a value.
    super(`Missing required secret: ${secretName}`);
    this.name = 'MissingSecretError';
  }
}

export interface SecretLoader {
  require(name: string): string;
  optional(name: string): string | undefined;
  redact(text: string): string;
}

/**
 * Builds a SecretLoader over a source map (defaults to process.env).
 * Tracks the set of known secret values so redact() can mask them in logs (Req 13.4).
 */
export function createSecretLoader(
  source: Record<string, string | undefined> = process.env,
  secretKeyPatterns: RegExp[] = [/SECRET/i, /PASSWORD/i, /TOKEN/i, /API_KEY/i, /DATABASE_URL/i],
): SecretLoader {
  const knownSecretValues = new Set<string>();

  const trackIfSecret = (name: string, value: string | undefined) => {
    if (value && secretKeyPatterns.some((p) => p.test(name)) && value.length >= 4) {
      knownSecretValues.add(value);
    }
  };

  // Pre-scan source for secret-like keys so redaction works even before require().
  for (const [k, v] of Object.entries(source)) {
    trackIfSecret(k, v);
  }

  return {
    require(name: string): string {
      const value = source[name];
      if (value === undefined || value === '') {
        throw new MissingSecretError(name);
      }
      trackIfSecret(name, value);
      return value;
    },
    optional(name: string): string | undefined {
      const value = source[name];
      if (value === '') return undefined;
      trackIfSecret(name, value);
      return value;
    },
    redact(text: string): string {
      if (!text) return text;
      let out = text;
      for (const secret of knownSecretValues) {
        if (secret && out.includes(secret)) {
          out = out.split(secret).join('***REDACTED***');
        }
      }
      return out;
    },
  };
}

/**
 * Fail-fast validation of the full required-secret set at startup (Req 13.3).
 * Returns the first missing secret name, or null if all present.
 */
export function firstMissingSecret(
  loader: SecretLoader,
  requiredNames: string[],
): string | null {
  for (const name of requiredNames) {
    try {
      loader.require(name);
    } catch (err) {
      if (err instanceof MissingSecretError) return err.secretName;
      throw err;
    }
  }
  return null;
}
