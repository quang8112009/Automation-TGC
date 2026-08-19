/**
 * classification — Data classification and labeling for compliance.
 *
 * Classifies data into sensitivity levels and applies retention policies.
 * Supports GDPR, CCPA, and Vietnamese PDPD (Personal Data Protection Decree)
 * compliance requirements.
 *
 * CLASSIFICATION LEVELS:
 *   PUBLIC      — Non-sensitive, safe for public disclosure.
 *   INTERNAL    — Internal use only, no PII.
 *   CONFIDENTIAL — Contains PII or business-sensitive data.
 *   RESTRICTED  — Highly sensitive (financial, health, government IDs).
 *
 * USAGE:
 *   import { classify, classifyField, ClassificationLevel } from '../governance/classification';
 *
 *   const level = classify({ email: 'user@test.com', name: 'Nguyen Van A' });
 *   // 'CONFIDENTIAL' (contains PII)
 *
 *   const label = classifyField('phone', '0912345678');
 *   // { level: 'CONFIDENTIAL', pii: ['PHONE_VN'], retention: '24_months' }
 */
import { detectPii, type PiiType } from './pii';

// ── Types ───────────────────────────────────────────────────────────────────

/** Data sensitivity classification levels. */
export type ClassificationLevel = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

/** Compliance frameworks. */
export type ComplianceFramework = 'GDPR' | 'CCPA' | 'PDPD' | 'PCI_DSS' | 'HIPAA';

/** Classification result for a field or object. */
export interface ClassificationResult {
  /** The overall classification level. */
  level: ClassificationLevel;
  /** PII types detected. */
  piiTypes: PiiType[];
  /** Retention period recommendation. */
  retention: RetentionPeriod;
  /** Compliance frameworks that apply. */
  compliance: ComplianceFramework[];
  /** Whether encryption is recommended. */
  encryptionRecommended: boolean;
  /** Whether masking is recommended for logs. */
  maskInLogs: boolean;
  /** Human-readable explanation. */
  reason: string;
}

/** Field-level classification. */
export interface FieldClassification {
  /** Field name. */
  field: string;
  /** Classification level. */
  level: ClassificationLevel;
  /** Detected PII types (empty if none). */
  piiTypes: PiiType[];
  /** Retention period. */
  retention: RetentionPeriod;
  /** Whether the field should be encrypted at rest. */
  encryptAtRest: boolean;
  /** Whether the field should be masked in logs. */
  maskInLogs: boolean;
}

/** Retention periods. */
export type RetentionPeriod =
  | 'session'          // Delete after session ends
  | '30_days'
  | '90_days'
  | '6_months'
  | '12_months'
  | '24_months'
  | '36_months'
  | 'indefinite'       // Keep indefinitely (public data)
  | 'legal_hold';      // Preserve indefinitely (legal requirement)

// ── Classification Rules ────────────────────────────────────────────────────

/** PII type → classification level mapping. */
const PII_CLASSIFICATION: Readonly<Record<PiiType, ClassificationLevel>> = {
  EMAIL: 'CONFIDENTIAL',
  PHONE_VN: 'CONFIDENTIAL',
  PHONE_INTL: 'CONFIDENTIAL',
  CCCD: 'RESTRICTED',
  CMND: 'RESTRICTED',
  PASSPORT: 'RESTRICTED',
  BANK_ACCOUNT: 'RESTRICTED',
  BANK_CARD: 'RESTRICTED',
  TAX_ID: 'RESTRICTED',
  DATE_OF_BIRTH: 'CONFIDENTIAL',
  FULL_NAME: 'CONFIDENTIAL',
  ADDRESS: 'CONFIDENTIAL',
  IP_ADDRESS: 'INTERNAL',
  CREDIT_CARD: 'RESTRICTED',
  SSN: 'RESTRICTED',
  POSTAL_CODE: 'INTERNAL',
};

/** PII type → retention period mapping. */
const PII_RETENTION: Readonly<Record<PiiType, RetentionPeriod>> = {
  EMAIL: '24_months',
  PHONE_VN: '24_months',
  PHONE_INTL: '24_months',
  CCCD: '36_months',
  CMND: '36_months',
  PASSPORT: '36_months',
  BANK_ACCOUNT: '36_months',
  BANK_CARD: '36_months',
  TAX_ID: '36_months',
  DATE_OF_BIRTH: '24_months',
  FULL_NAME: '24_months',
  ADDRESS: '24_months',
  IP_ADDRESS: '12_months',
  CREDIT_CARD: 'legal_hold',
  SSN: 'legal_hold',
  POSTAL_CODE: '12_months',
};

/** PII type → applicable compliance frameworks. */
const PII_COMPLIANCE: Readonly<Record<PiiType, ComplianceFramework[]>> = {
  EMAIL: ['GDPR', 'CCPA', 'PDPD'],
  PHONE_VN: ['PDPD'],
  PHONE_INTL: ['GDPR', 'CCPA'],
  CCCD: ['PDPD'],
  CMND: ['PDPD'],
  PASSPORT: ['GDPR', 'PDPD'],
  BANK_ACCOUNT: ['PCI_DSS', 'PDPD'],
  BANK_CARD: ['PCI_DSS'],
  TAX_ID: ['PDPD'],
  DATE_OF_BIRTH: ['GDPR', 'CCPA', 'PDPD'],
  FULL_NAME: ['GDPR', 'CCPA', 'PDPD'],
  ADDRESS: ['GDPR', 'CCPA', 'PDPD'],
  IP_ADDRESS: ['GDPR', 'CCPA'],
  CREDIT_CARD: ['PCI_DSS'],
  SSN: ['PCI_DSS'],
  POSTAL_CODE: ['GDPR', 'CCPA'],
};

// ── Classification Functions ────────────────────────────────────────────────

/** Well-known field names that imply specific classification. */
const FIELD_HINTS: Readonly<Record<string, { level: ClassificationLevel; pii?: PiiType }>> = {
  email: { level: 'CONFIDENTIAL', pii: 'EMAIL' },
  phone: { level: 'CONFIDENTIAL', pii: 'PHONE_VN' },
  password: { level: 'RESTRICTED' },
  secret: { level: 'RESTRICTED' },
  token: { level: 'RESTRICTED' },
  api_key: { level: 'RESTRICTED' },
  ssn: { level: 'RESTRICTED', pii: 'SSN' },
  credit_card: { level: 'RESTRICTED', pii: 'CREDIT_CARD' },
  bank_account: { level: 'RESTRICTED', pii: 'BANK_ACCOUNT' },
  id_card: { level: 'RESTRICTED', pii: 'CCCD' },
  passport: { level: 'RESTRICTED', pii: 'PASSPORT' },
  address: { level: 'CONFIDENTIAL', pii: 'ADDRESS' },
  date_of_birth: { level: 'CONFIDENTIAL', pii: 'DATE_OF_BIRTH' },
  name: { level: 'CONFIDENTIAL', pii: 'FULL_NAME' },
  title: { level: 'INTERNAL' },
  body: { level: 'INTERNAL' },
  status: { level: 'PUBLIC' },
  created_at: { level: 'PUBLIC' },
  updated_at: { level: 'PUBLIC' },
};

/**
 * Classify a value based on its content (PII detection).
 */
export function classifyValue(value: unknown): ClassificationLevel {
  if (value === null || value === undefined) return 'PUBLIC';
  if (typeof value !== 'string') return 'INTERNAL';

  const detections = detectPii(value);
  if (detections.length === 0) return 'PUBLIC';

  // Return the highest classification level found.
  const levels: ClassificationLevel[] = detections.map(
    (d) => PII_CLASSIFICATION[d.type] ?? 'CONFIDENTIAL',
  );

  if (levels.includes('RESTRICTED')) return 'RESTRICTED';
  if (levels.includes('CONFIDENTIAL')) return 'CONFIDENTIAL';
  if (levels.includes('INTERNAL')) return 'INTERNAL';
  return 'PUBLIC';
}

/**
 * Classify a field by name and value.
 */
export function classifyField(
  fieldName: string,
  value: unknown,
): FieldClassification {
  const normalizedName = fieldName.toLowerCase().replace(/[_-]/g, '');

  // Check field name hints first.
  for (const [hint, config] of Object.entries(FIELD_HINTS)) {
    if (normalizedName.includes(hint.replace(/[_-]/g, ''))) {
      return {
        field: fieldName,
        level: config.level,
        piiTypes: config.pii ? [config.pii] : [],
        retention: config.pii ? (PII_RETENTION[config.pii] ?? '24_months') : 'indefinite',
        encryptAtRest: config.level === 'RESTRICTED',
        maskInLogs: config.level !== 'PUBLIC',
      };
    }
  }

  // Fall back to content-based detection.
  const detections = detectPii(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
  const piiTypes = [...new Set(detections.map((d) => d.type))];
  const levels = piiTypes.map((t) => PII_CLASSIFICATION[t] ?? 'CONFIDENTIAL');

  let level: ClassificationLevel = 'PUBLIC';
  if (levels.includes('RESTRICTED')) level = 'RESTRICTED';
  else if (levels.includes('CONFIDENTIAL')) level = 'CONFIDENTIAL';
  else if (levels.includes('INTERNAL')) level = 'INTERNAL';

  const retention = piiTypes.length > 0
    ? piiTypes.reduce((latest, t) => {
        const r = PII_RETENTION[t];
        return retentionPriority(r) > retentionPriority(latest) ? r : latest;
      }, 'indefinite' as RetentionPeriod)
    : 'indefinite';

  return {
    field: fieldName,
    level,
    piiTypes,
    retention,
    encryptAtRest: level === 'RESTRICTED',
    maskInLogs: level !== 'PUBLIC',
  };
}

/**
 * Classify an entire object (all fields).
 */
export function classifyObject(obj: Record<string, unknown>): ClassificationResult {
  const allPiiTypes: PiiType[] = [];
  let highestLevel: ClassificationLevel = 'PUBLIC';

  for (const [key, value] of Object.entries(obj)) {
    const fieldResult = classifyField(key, value);
    allPiiTypes.push(...fieldResult.piiTypes);

    if (levelPriority(fieldResult.level) > levelPriority(highestLevel)) {
      highestLevel = fieldResult.level;
    }
  }

  const uniquePiiTypes = [...new Set(allPiiTypes)];
  const compliance = [...new Set(uniquePiiTypes.flatMap((t) => PII_COMPLIANCE[t] ?? []))];
  const retention = uniquePiiTypes.length > 0
    ? uniquePiiTypes.reduce((latest, t) => {
        const r = PII_RETENTION[t];
        return retentionPriority(r) > retentionPriority(latest) ? r : latest;
      }, 'indefinite' as RetentionPeriod)
    : 'indefinite';

  return {
    level: highestLevel,
    piiTypes: uniquePiiTypes,
    retention,
    compliance,
    encryptionRecommended: highestLevel === 'RESTRICTED',
    maskInLogs: highestLevel !== 'PUBLIC',
    reason: uniquePiiTypes.length > 0
      ? `Contains ${uniquePiiTypes.length} PII type(s): ${uniquePiiTypes.join(', ')}`
      : 'No PII detected',
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function levelPriority(level: ClassificationLevel): number {
  switch (level) {
    case 'PUBLIC': return 0;
    case 'INTERNAL': return 1;
    case 'CONFIDENTIAL': return 2;
    case 'RESTRICTED': return 3;
    default: return 0;
  }
}

function retentionPriority(retention: RetentionPeriod): number {
  switch (retention) {
    case 'session': return 0;
    case '30_days': return 1;
    case '90_days': return 2;
    case '6_months': return 3;
    case '12_months': return 4;
    case '24_months': return 5;
    case '36_months': return 6;
    case 'indefinite': return 7;
    case 'legal_hold': return 8;
    default: return 0;
  }
}

/**
 * Get a human-readable label for a classification level.
 */
export function classificationLabel(level: ClassificationLevel): string {
  switch (level) {
    case 'PUBLIC': return '🟢 Public — Safe for public disclosure';
    case 'INTERNAL': return '🔵 Internal — Internal use only';
    case 'CONFIDENTIAL': return '🟡 Confidential — Contains PII, restricted access';
    case 'RESTRICTED': return '🔴 Restricted — Highly sensitive, encryption required';
    default: return '⚪ Unknown';
  }
}

/**
 * Get a human-readable label for a retention period.
 */
export function retentionLabel(retention: RetentionPeriod): string {
  switch (retention) {
    case 'session': return 'Delete after session';
    case '30_days': return '30 days';
    case '90_days': return '90 days';
    case '6_months': return '6 months';
    case '12_months': return '12 months';
    case '24_months': return '24 months';
    case '36_months': return '36 months';
    case 'indefinite': return 'Indefinite';
    case 'legal_hold': return 'Legal hold (preserve indefinitely)';
    default: return 'Unknown';
  }
}
