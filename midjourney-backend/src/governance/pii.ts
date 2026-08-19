/**
 * pii — PII detection, classification, and masking engine.
 *
 * Detects and masks personally identifiable information in strings and objects.
 * Supports Vietnamese + international PII patterns (CCCD, phone numbers, emails,
 * addresses, bank accounts, etc.).
 *
 * DESIGN:
 *   - Pure functions: no I/O, deterministic, unit-testable.
 *   - Regex-based detection with confidence scoring.
 *   - Multiple masking strategies: full mask, partial mask, hash, redact.
 *   - Object-level scanning: recursively walks nested objects/arrays.
 *   - GDPR/CCPA compliant: supports right-to-erasure via masking.
 *
 * USAGE:
 *   import { detectPii, maskPii, maskObject } from '../governance/pii';
 *
 *   const found = detectPii('My email is test@example.com');
 *   // [{ type: 'EMAIL', value: 'test@example.com', confidence: 0.99, start: 12, end: 28 }]
 *
 *   const masked = maskPii('Call 0912345678');
 *   // 'Call 0912***678'
 */
import { hashSha256 } from './encryption';

// ── Types ───────────────────────────────────────────────────────────────────

/** PII type identifiers. */
export type PiiType =
  | 'EMAIL'
  | 'PHONE_VN'
  | 'PHONE_INTL'
  | 'CCCD'           // Căn cước công dân (Vietnamese national ID)
  | 'CMND'           // Chứng minh nhân dân (old Vietnamese ID)
  | 'PASSPORT'
  | 'BANK_ACCOUNT'
  | 'BANK_CARD'
  | 'TAX_ID'         // Mã số thuế (Vietnamese tax ID)
  | 'DATE_OF_BIRTH'
  | 'FULL_NAME'
  | 'ADDRESS'
  | 'IP_ADDRESS'
  | 'CREDIT_CARD'
  | 'SSN'            // US Social Security Number
  | 'POSTAL_CODE';

/** A detected PII instance in text. */
export interface PiiDetection {
  /** The type of PII detected. */
  type: PiiType;
  /** The raw detected value. */
  value: string;
  /** Confidence score (0-1). */
  confidence: number;
  /** Start index in the original string. */
  start: number;
  /** End index in the original string. */
  end: number;
}

/** Masking strategy. */
export type MaskStrategy = 'full' | 'partial' | 'hash' | 'redact' | 'tokenize';

/** Masking options. */
export interface MaskOptions {
  /** Strategy to use (default: 'partial'). */
  strategy?: MaskStrategy;
  /** Character to use for masking (default: '*'). */
  maskChar?: string;
  /** Number of visible chars at start (partial mode). */
  visibleStart?: number;
  /** Number of visible chars at end (partial mode). */
  visibleEnd?: number;
  /** Hash salt for 'hash' strategy. */
  hashSalt?: string;
  /** Token map for 'tokenize' strategy. */
  tokenMap?: Map<string, string>;
}

// ── PII Patterns ────────────────────────────────────────────────────────────

/** Regex patterns for PII detection. Each entry: [type, regex, confidence]. */
const PII_PATTERNS: ReadonlyArray<[PiiType, RegExp, number]> = [
  // Email (international)
  ['EMAIL', /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, 0.99],

  // Vietnamese phone numbers (0xx-xxxx-xxxx, +84xx, 84xx)
  ['PHONE_VN', /(?:\+84|84|0)(?:3[2-9]|5[689]|7[0689]|8[1-9]|9[0-9])\d{7}\b/g, 0.95],

  // International phone numbers (basic E.164)
  ['PHONE_INTL', /\+[1-9]\d{6,14}/g, 0.80],

  // Vietnamese CCCD (12 digits, starting with 0 or 1)
  ['CCCD', /\b[0-1]\d{11}\b/g, 0.85],

  // Vietnamese CMND (9 digits)
  ['CMND', /\b\d{9}\b/g, 0.60],

  // Passport (various formats: VN, US, etc.)
  ['PASSPORT', /\b[A-Z]{1,2}\d{6,8}\b/g, 0.50],

  // Vietnamese bank account numbers (10-14 digits)
  ['BANK_ACCOUNT', /\b\d{10,14}\b/g, 0.40],

  // Vietnamese tax ID (10 or 13 digits, starting with 0-9)
  ['TAX_ID', /\b\d{10}(?:\d{3})?\b/g, 0.50],

  // Credit card numbers (13-19 digits, optional spaces/dashes)
  ['CREDIT_CARD', /\b(?:\d[ -]*?){13,19}\b/g, 0.70],

  // US SSN (xxx-xx-xxxx)
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/g, 0.90],

  // IP addresses (IPv4)
  ['IP_ADDRESS', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 0.85],

  // Date of birth (DD/MM/YYYY or DD-MM-YYYY, common in VN)
  ['DATE_OF_BIRTH', /\b(?:0[1-9]|[12]\d|3[01])[\/\-](?:0[1-9]|1[0-2])[\/\-](?:19|20)\d{2}\b/g, 0.75],

  // Vietnamese postal codes (6 digits)
  ['POSTAL_CODE', /\b\d{6}\b/g, 0.45],
];

// Vietnamese address keywords (for contextual detection).
const VN_ADDRESS_KEYWORDS = [
  'đường', 'phố', 'quận', 'huyện', 'thành phố', 'tỉnh', 'phường', 'xã',
  'số', 'ngõ', 'ngách', 'khu', 'tổ', 'thôn', 'đội',
];

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Detect PII in a string. Returns all matches with type, value, confidence, and position.
 *
 * @param text - The text to scan.
 * @param options - Optional: restrict to specific PII types.
 * @returns Array of PII detections, sorted by start position.
 */
export function detectPii(
  text: string,
  options?: { types?: PiiType[] },
): PiiDetection[] {
  if (!text || text.length === 0) return [];

  const detections: PiiDetection[] = [];
  const allowedTypes = options?.types ? new Set(options.types) : null;

  for (const [type, regex, confidence] of PII_PATTERNS) {
    if (allowedTypes && !allowedTypes.has(type)) continue;

    // Reset regex state for each pattern.
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      const value = match[0];

      // Skip very short matches (likely false positives).
      if (value.length < 3) continue;

      // Contextual boost: if near Vietnamese address keywords, boost confidence.
      let adjustedConfidence = confidence;
      const surrounding = text.slice(Math.max(0, match.index - 30), match.index + value.length + 30);
      if (VN_ADDRESS_KEYWORDS.some((kw) => surrounding.toLowerCase().includes(kw))) {
        if (type === 'BANK_ACCOUNT' || type === 'POSTAL_CODE') {
          adjustedConfidence = Math.min(0.95, confidence + 0.3);
        }
      }

      detections.push({
        type,
        value,
        confidence: Math.round(adjustedConfidence * 100) / 100,
        start: match.index,
        end: match.index + value.length,
      });
    }
  }

  // Sort by start position, deduplicate overlapping detections.
  detections.sort((a, b) => a.start - b.start || b.confidence - a.confidence);

  // Remove overlapping detections (keep higher confidence).
  const deduplicated: PiiDetection[] = [];
  let lastEnd = -1;
  for (const d of detections) {
    if (d.start >= lastEnd) {
      deduplicated.push(d);
      lastEnd = d.end;
    }
  }

  return deduplicated;
}

/**
 * Detect PII in an object (recursive scan of all string values).
 */
export function detectPiiInObject(
  obj: unknown,
  path = '',
): Array<PiiDetection & { path: string }> {
  const results: Array<PiiDetection & { path: string }> = [];

  if (typeof obj === 'string') {
    const detections = detectPii(obj);
    for (const d of detections) {
      results.push({ ...d, path: path || '(root)' });
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...detectPiiInObject(obj[i], `${path}[${i}]`));
    }
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      results.push(...detectPiiInObject(value, path ? `${path}.${key}` : key));
    }
  }

  return results;
}

// ── Masking ─────────────────────────────────────────────────────────────────

/**
 * Mask a single PII detection according to the specified strategy.
 */
export function maskValue(value: string, type: PiiType, options: MaskOptions = {}): string {
  const strategy = options.strategy ?? 'partial';
  const maskChar = options.maskChar ?? '*';

  switch (strategy) {
    case 'full':
      return maskChar.repeat(value.length);

    case 'partial': {
      const visStart = options.visibleStart ?? 3;
      const visEnd = options.visibleEnd ?? 3;
      if (value.length <= visStart + visEnd) {
        return maskChar.repeat(value.length);
      }
      const start = value.slice(0, visStart);
      const end = value.slice(-visEnd);
      const middle = maskChar.repeat(value.length - visStart - visEnd);
      return `${start}${middle}${end}`;
    }

    case 'hash': {
      const salt = options.hashSalt ?? '';
      return `[HASH:${hashSha256(value + salt).slice(0, 12)}]`;
    }

    case 'redact':
      return `[REDACTED:${type}]`;

    case 'tokenize': {
      if (!options.tokenMap) {
        options.tokenMap = new Map();
      }
      let token = options.tokenMap.get(value);
      if (!token) {
        token = `TOK-${options.tokenMap.size + 1}`;
        options.tokenMap.set(value, token);
      }
      return token;
    }

    default:
      return maskChar.repeat(value.length);
  }
}

/**
 * Mask all PII in a string.
 *
 * @param text - The text to mask.
 * @param options - Masking strategy and options.
 * @returns Masked text with PII replaced.
 */
export function maskPii(text: string, options: MaskOptions = {}): string {
  const detections = detectPii(text);
  if (detections.length === 0) return text;

  // Process from end to start to preserve indices.
  let result = text;
  for (let i = detections.length - 1; i >= 0; i--) {
    const d = detections[i];
    const masked = maskValue(d.value, d.type, options);
    result = result.slice(0, d.start) + masked + result.slice(d.end);
  }

  return result;
}

/**
 * Mask PII in an object (returns a new object with all string values masked).
 */
export function maskObject<T extends Record<string, unknown>>(
  obj: T,
  options: MaskOptions = {},
): T {
  const result = { ...obj };

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') {
      (result as Record<string, unknown>)[key] = maskPii(value, options);
    } else if (Array.isArray(value)) {
      (result as Record<string, unknown>)[key] = value.map((item) =>
        typeof item === 'string' ? maskPii(item, options) : item,
      );
    } else if (value && typeof value === 'object') {
      (result as Record<string, unknown>)[key] = maskObject(value as Record<string, unknown>, options);
    }
  }

  return result;
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** Summary of PII found in a scan. */
export interface PiiScanReport {
  /** Total PII instances found. */
  totalFound: number;
  /** Breakdown by PII type. */
  byType: Record<string, number>;
  /** Average confidence score. */
  avgConfidence: number;
  /** Whether any high-confidence PII was found. */
  hasHighConfidence: boolean;
  /** The detections themselves. */
  detections: PiiDetection[];
}

/**
 * Generate a PII scan report for a text.
 */
export function scanReport(text: string): PiiScanReport {
  const detections = detectPii(text);
  const byType: Record<string, number> = {};

  for (const d of detections) {
    byType[d.type] = (byType[d.type] ?? 0) + 1;
  }

  const avgConfidence = detections.length > 0
    ? detections.reduce((sum, d) => sum + d.confidence, 0) / detections.length
    : 0;

  return {
    totalFound: detections.length,
    byType,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    hasHighConfidence: detections.some((d) => d.confidence >= 0.8),
    detections,
  };
}
