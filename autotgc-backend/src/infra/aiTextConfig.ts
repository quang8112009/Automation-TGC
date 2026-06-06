/**
 * AI text configuration — Config_Parser (pure).
 *
 * Provider-neutral configuration for the text-generation gateway. The whole
 * system targets an OpenAI-compatible ChatCompletions gateway (currently
 * DeepSeek V4), so the configuration carries EXACTLY four normalized,
 * non-secret properties: `{provider, baseUrl, model, timeout}`.
 *
 * IMPORTANT — secrets: the API key is NEVER part of `AiTextConfig`. This module
 * only reads the non-secret connection keys (`GEMINI_BASE_URL`, `GEMINI_MODEL`,
 * `GEMINI_TIMEOUT_MS`) and must never accept, store, log, or throw a secret
 * value. The API key is read separately at composition time and handed to the
 * client directly (see design: Config_Parser / Pretty_Printer).
 *
 * Pure & framework-free so it can be exhaustively property-tested with
 * fast-check (Requirements 2.1–2.3, 6.1, 6.4, 6.5).
 */
import type { SecretLoader } from './secrets';

/** Normalized AI text configuration — EXACTLY four properties (R6.1). */
export interface AiTextConfig {
  /** Neutral provider label, e.g. 'deepseek'. NOT a secret. */
  readonly provider: string;
  /** Gateway `/v1` base, a non-empty string. NOT a secret. */
  readonly baseUrl: string;
  /** DeepSeek_Model_Id, a non-empty string. NOT a secret. */
  readonly model: string;
  /** Timeout (ms): a finite, normalized positive number `>= AI_TEXT_MIN_TIMEOUT_MS`. */
  readonly timeout: number;
}

/**
 * Raw input as read from the SecretLoader (values may be undefined/empty).
 * `apiKey` is intentionally absent — it is NOT part of the parsed config (R6.2, R2.7).
 */
export interface RawAiTextConfig {
  provider?: string;
  baseUrl?: string;
  model?: string;
  /** Raw env string or number; the parser normalizes it. */
  timeout?: string | number;
}

/** Successful parse result carrying the normalized config. */
export interface ConfigParseOk {
  readonly ok: true;
  readonly config: AiTextConfig;
}

/**
 * Failed parse result. Names which key is invalid WITHOUT including any secret
 * value (R6.5). `invalidKey` is restricted to the two required string keys.
 */
export interface ConfigParseError {
  readonly ok: false;
  readonly invalidKey: 'baseUrl' | 'model';
  readonly message: string;
}

export type ConfigParseResult = ConfigParseOk | ConfigParseError;

/** Default neutral provider label when none is configured. NOT a secret. */
export const AI_TEXT_DEFAULT_PROVIDER = 'deepseek';
/** Default model when `GEMINI_MODEL` is absent (R2.2). */
export const AI_TEXT_DEFAULT_MODEL = 'deepseek-v4-flash';
/** Default outbound timeout (ms) when timeout is absent/invalid (R2.3, R6.4). */
export const AI_TEXT_DEFAULT_TIMEOUT_MS = 20_000;
/** Minimum accepted timeout (ms); below this the default applies (R2.3). */
export const AI_TEXT_MIN_TIMEOUT_MS = 100;

/**
 * Normalize a raw timeout value. Valid IFF it is a finite number, `> 0`, AND
 * `>= AI_TEXT_MIN_TIMEOUT_MS` (100). Numeric strings are parsed. Any other case
 * (absent, empty/non-numeric string, NaN, Infinity, <= 0, < 100) falls back to
 * `AI_TEXT_DEFAULT_TIMEOUT_MS` (20000). (R2.3, R6.4)
 */
function normalizeTimeout(raw: string | number | undefined): number {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return AI_TEXT_DEFAULT_TIMEOUT_MS;
    value = Number(trimmed);
  } else {
    return AI_TEXT_DEFAULT_TIMEOUT_MS;
  }
  if (Number.isFinite(value) && value > 0 && value >= AI_TEXT_MIN_TIMEOUT_MS) {
    return value;
  }
  return AI_TEXT_DEFAULT_TIMEOUT_MS;
}

/**
 * Config_Parser (pure). Builds a normalized `AiTextConfig` of EXACTLY four
 * properties, or reports which required key is invalid.
 *
 * Rules:
 * - `baseUrl` is REQUIRED: absent/empty/whitespace ⇒ `ok:false, invalidKey:'baseUrl'` (R6.5).
 * - `model` DEFAULTS to `deepseek-v4-flash` when absent; if explicitly provided
 *   but empty/whitespace ⇒ `ok:false, invalidKey:'model'` (R2.2, R6.5).
 * - `provider` DEFAULTS to `deepseek` when absent/blank (not a required key).
 * - `timeout` is normalized via {@link normalizeTimeout} (R2.3, R6.4).
 * - The API key is NEVER accepted or stored here (R6.2, R2.7).
 */
export function parseAiTextConfig(raw: RawAiTextConfig): ConfigParseResult {
  // baseUrl is required and must be a non-empty, non-whitespace string.
  const baseUrl = raw.baseUrl;
  if (baseUrl === undefined || baseUrl.trim().length === 0) {
    return {
      ok: false,
      invalidKey: 'baseUrl',
      message: 'base URL is required and must be a non-empty string',
    };
  }

  // model defaults when absent; only an explicitly-provided empty/whitespace
  // value is rejected — an absent value uses the default and is never invalid.
  let model: string;
  if (raw.model === undefined) {
    model = AI_TEXT_DEFAULT_MODEL;
  } else if (raw.model.trim().length === 0) {
    return {
      ok: false,
      invalidKey: 'model',
      message: 'model must be a non-empty string when provided',
    };
  } else {
    model = raw.model;
  }

  const provider =
    raw.provider !== undefined && raw.provider.trim().length > 0
      ? raw.provider
      : AI_TEXT_DEFAULT_PROVIDER;
  const timeout = normalizeTimeout(raw.timeout);

  return {
    ok: true,
    config: { provider, baseUrl, model, timeout },
  };
}

/**
 * Convenience for `composeServices`: read the non-secret connection keys from
 * the SecretLoader and delegate to {@link parseAiTextConfig}. The API key
 * (`GEMINI_API_KEY`) is intentionally NOT read here — it is not part of the
 * parsed config (R2.1, R6.2).
 */
export function parseAiTextConfigFromSecrets(secrets: SecretLoader): ConfigParseResult {
  return parseAiTextConfig({
    baseUrl: secrets.optional('GEMINI_BASE_URL'),
    model: secrets.optional('GEMINI_MODEL'),
    timeout: secrets.optional('GEMINI_TIMEOUT_MS'),
  });
}

/**
 * Pretty_Printer (pure). Render an `AiTextConfig` as a deterministic, secret-free
 * text representation: EXACTLY the four properties emitted as `key=value` lines,
 * one per line, in a stable order (provider, baseUrl, model, timeout).
 *
 * Secrets: the output NEVER contains an API key or any secret value — by design
 * `AiTextConfig` carries no secret field (R6.2). The result is deterministic: the
 * same config always yields the same string.
 *
 * Format: values are emitted verbatim. Since `provider`, `baseUrl` and `model`
 * are single-line strings and `timeout` is numeric, no escaping is needed. The
 * reader {@link parsePrintedAiTextConfig} splits each line on the FIRST `=`, so a
 * value that itself contains `=` (e.g. a URL with a query string) round-trips
 * correctly. (R6.2, R6.3)
 */
export function printAiTextConfig(config: AiTextConfig): string {
  return [
    `provider=${config.provider}`,
    `baseUrl=${config.baseUrl}`,
    `model=${config.model}`,
    `timeout=${config.timeout}`,
  ].join('\n');
}

/**
 * Symmetric inverse of {@link printAiTextConfig}. Reads text produced by the
 * Pretty_Printer back into an `AiTextConfig`, normalizing `timeout` to a number.
 *
 * Each line is split on the FIRST `=`: the substring before it is the key and the
 * (possibly `=`-containing) remainder is the value, so URLs with query strings are
 * preserved. The round-trip invariant holds for any valid config produced by the
 * Config_Parser: `parsePrintedAiTextConfig(printAiTextConfig(c))` deep-equals `c`
 * on all four properties `{provider, baseUrl, model, timeout}`. (R6.3)
 */
export function parsePrintedAiTextConfig(text: string): AiTextConfig {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const sep = line.indexOf('=');
    if (sep < 0) continue;
    const key = line.slice(0, sep);
    values[key] = line.slice(sep + 1);
  }
  return {
    provider: values.provider ?? '',
    baseUrl: values.baseUrl ?? '',
    model: values.model ?? '',
    timeout: Number(values.timeout),
  };
}
