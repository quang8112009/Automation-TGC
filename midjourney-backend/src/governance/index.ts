/**
 * governance — Unified data protection and governance platform.
 *
 * Provides a single entry point for all governance capabilities:
 *   - Encryption: AES-256-GCM at-rest encryption, hashing, key derivation.
 *   - PII: Detection, classification, and masking of personal data.
 *   - Classification: Data sensitivity labeling for compliance.
 *   - Audit: Immutable, tamper-evident audit logging.
 *   - Retention: Data lifecycle management and purge policies.
 *   - Protection: Cloud workload security scanning.
 *
 * QUICK START:
 *   import { encrypt, decrypt, detectPii, maskPii } from '../governance';
 *
 *   // Detect PII in user input.
 *   const pii = detectPii('Call 0912345678');
 *
 *   // Mask PII for logs.
 *   const safe = maskPii('Email: test@example.com');
 *
 *   // Encrypt sensitive fields.
 *   const encrypted = encrypt('secret-data', key);
 */

// ── Encryption ──────────────────────────────────────────────────────────────
export {
  encrypt,
  decrypt,
  hashSha256,
  hmacSha256,
  safeCompare,
  deriveKey,
  encryptField,
  decryptField,
  type EncryptedPayload,
} from './encryption';

// ── PII ─────────────────────────────────────────────────────────────────────
export {
  detectPii,
  detectPiiInObject,
  maskPii,
  maskObject,
  maskValue,
  scanReport,
  type PiiDetection,
  type PiiType,
  type MaskOptions,
  type MaskStrategy,
  type PiiScanReport,
} from './pii';

// ── Classification ──────────────────────────────────────────────────────────
export {
  classifyField,
  classifyObject,
  classifyValue,
  classificationLabel,
  retentionLabel,
  type ClassificationLevel,
  type ClassificationResult,
  type FieldClassification,
  type RetentionPeriod,
} from './classification';

// ── Audit ───────────────────────────────────────────────────────────────────
export {
  AuditLogger,
  type AuditAction,
  type AuditActor,
  type AuditResource,
  type AuditEntry,
  type AuditQuery,
} from './audit';

// ── Retention ───────────────────────────────────────────────────────────────
export {
  RetentionPolicy,
  type PurgeResult,
  type PurgeOptions,
  type TableRetentionConfig,
} from './retention';

// ── Protection ──────────────────────────────────────────────────────────────
export {
  scanWorkload,
  auditEnvironment,
  auditConfiguration,
  scanSourceCode,
  type Finding,
  type Severity,
  type ProtectionReport,
  type ScanOptions,
} from './protection';

// ── Middleware ──────────────────────────────────────────────────────────────
export {
  registerGovernance,
  governanceRoute,
  maskErrorBody,
  type RequestGovernance,
  type GovernanceConfig,
  type RouteGovernanceOptions,
} from './middleware';

// ── Dashboard ──────────────────────────────────────────────────────────────
export { ComplianceDashboard } from './dashboard';
export type {
  AuditSummary,
  PiiExposureReport,
  RetentionStatus,
  ConsentOverview,
  ProtectionSummary,
  DsarSummary,
  ComplianceDashboardOverview,
} from './dashboard';

// ── Routes ─────────────────────────────────────────────────────────────────
export { registerGovernanceRoutes } from './routes';

// ── Alerting ─────────────────────────────────────────────────────────────
export { ComplianceAlerter } from './alerting';
export type {
  AlertSeverity,
  AlertType,
  AlertChannels,
  AlertThresholds,
  ComplianceAlert,
  AlertHistoryEntry,
  EvaluationResult,
  ComplianceSnapshot,
} from './alerting';
