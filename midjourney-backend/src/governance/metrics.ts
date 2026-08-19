/**
 * governance/metrics — Prometheus metrics for compliance scores.
 *
 * Exports compliance, security, retention, and alerting metrics in the
 * Prometheus exposition format for scraping by Prometheus and visualization
 * in Grafana dashboards.
 *
 * Metrics registered:
 *   compliance_score{dimension}        — Gauge (0-100) per compliance dimension
 *   compliance_score_total             — Gauge (0-100) overall weighted score
 *   compliance_alerts_total{severity,type} — Counter of fired alerts
 *   compliance_alert_cooldown_seconds  — Gauge of configured cooldown
 *   compliance_findings_total{severity} — Gauge of current security findings
 *   compliance_retention_expired_total — Gauge of expired records per table
 *   compliance_retention_table_status  — Gauge (0=healthy, 1=warning, 2=critical)
 *   compliance_consent_rate            — Gauge (0-100) consent rate
 *   compliance_dsar_compliance_rate    — Gauge (0-100) DSAR compliance rate
 *   compliance_pii_classification_level — Gauge (0=PUBLIC, 1=INTERNAL, 2=CONFIDENTIAL, 3=RESTRICTED)
 *   compliance_evaluation_duration_seconds — Histogram of evaluation time
 *
 * USAGE:
 *   import { ComplianceMetrics } from '../governance/metrics';
 *   const metrics = new ComplianceMetrics();
 *   metrics.recordEvaluation(score, dimensions, snapshot);
 *   const prometheusText = await metrics.getMetrics();
 */
import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import type { ComplianceSnapshot } from './alerting';
import type { AuditSummary, PiiExposureReport, RetentionStatus, ConsentOverview, ProtectionSummary, DsarSummary } from './dashboard';

// ── Classification level mapping ─────────────────────────────────────────────

const CLASSIFICATION_LEVEL: Record<string, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
};

const RETENTION_STATUS: Record<string, number> = {
  healthy: 0,
  warning: 1,
  critical: 2,
};

// ── Compliance Metrics ───────────────────────────────────────────────────────

/**
 * Prometheus metrics collector for the compliance platform.
 */
export class ComplianceMetrics {
  private readonly registry: Registry;

  // ── Compliance score gauges ───────────────────────────────────────────
  private readonly complianceScoreTotal: Gauge;
  private readonly complianceScoreAudit: Gauge;
  private readonly complianceScorePii: Gauge;
  private readonly complianceScoreRetention: Gauge;
  private readonly complianceScoreConsent: Gauge;
  private readonly complianceScoreSecurity: Gauge;
  private readonly complianceScoreDsar: Gauge;

  // ── Alerting metrics ──────────────────────────────────────────────────
  private readonly alertsFired: Counter;
  private readonly alertCooldownSeconds: Gauge;

  // ── Security metrics ──────────────────────────────────────────────────
  private readonly securityFindings: Gauge;
  private readonly securityRiskScore: Gauge;
  private readonly securityVerdict: Gauge;

  // ── Retention metrics ─────────────────────────────────────────────────
  private readonly retentionExpiredRecords: Gauge;
  private readonly retentionTableStatus: Gauge;

  // ── Consent metrics ───────────────────────────────────────────────────
  private readonly consentRate: Gauge;

  // ── DSAR metrics ──────────────────────────────────────────────────────
  private readonly dsarComplianceRate: Gauge;

  // ── PII metrics ───────────────────────────────────────────────────────
  private readonly piiClassificationLevel: Gauge;

  // ── Audit metrics ─────────────────────────────────────────────────────
  private readonly auditEntriesTotal: Gauge;

  // ── Performance metrics ───────────────────────────────────────────────
  private readonly evaluationDuration: Histogram;

  constructor() {
    this.registry = new Registry();

    // Collect default Node.js metrics (CPU, memory, event loop, GC).
    collectDefaultMetrics({ register: this.registry, prefix: 'governance_' });

    // ── Compliance score ──────────────────────────────────────────────
    this.complianceScoreTotal = new Gauge({
      name: 'governance_compliance_score_total',
      help: 'Overall compliance score (0-100, higher is better)',
      registers: [this.registry],
    });

    this.complianceScoreAudit = new Gauge({
      name: 'governance_compliance_score_audit',
      help: 'Audit logging compliance sub-score (0-100)',
      registers: [this.registry],
    });

    this.complianceScorePii = new Gauge({
      name: 'governance_compliance_score_pii',
      help: 'PII protection compliance sub-score (0-100)',
      registers: [this.registry],
    });

    this.complianceScoreRetention = new Gauge({
      name: 'governance_compliance_score_retention',
      help: 'Data retention compliance sub-score (0-100)',
      registers: [this.registry],
    });

    this.complianceScoreConsent = new Gauge({
      name: 'governance_compliance_score_consent',
      help: 'Consent management compliance sub-score (0-100)',
      registers: [this.registry],
    });

    this.complianceScoreSecurity = new Gauge({
      name: 'governance_compliance_score_security',
      help: 'Security posture compliance sub-score (0-100)',
      registers: [this.registry],
    });

    this.complianceScoreDsar = new Gauge({
      name: 'governance_compliance_score_dsar',
      help: 'DSAR compliance sub-score (0-100)',
      registers: [this.registry],
    });

    // ── Alerting ──────────────────────────────────────────────────────
    this.alertsFired = new Counter({
      name: 'governance_compliance_alerts_total',
      help: 'Total number of compliance alerts fired',
      labelNames: ['severity', 'type'],
      registers: [this.registry],
    });

    this.alertCooldownSeconds = new Gauge({
      name: 'governance_alert_cooldown_seconds',
      help: 'Configured alert cooldown in seconds',
      registers: [this.registry],
    });

    // ── Security ──────────────────────────────────────────────────────
    this.securityFindings = new Gauge({
      name: 'governance_security_findings_total',
      help: 'Number of current security findings by severity',
      labelNames: ['severity'],
      registers: [this.registry],
    });

    this.securityRiskScore = new Gauge({
      name: 'governance_security_risk_score',
      help: 'Workload security risk score (0-100, higher = worse)',
      registers: [this.registry],
    });

    this.securityVerdict = new Gauge({
      name: 'governance_security_verdict',
      help: 'Security scan verdict (0=PASS, 1=WARN, 2=FAIL)',
      registers: [this.registry],
    });

    // ── Retention ─────────────────────────────────────────────────────
    this.retentionExpiredRecords = new Gauge({
      name: 'governance_retention_expired_total',
      help: 'Number of expired records pending purge',
      labelNames: ['table'],
      registers: [this.registry],
    });

    this.retentionTableStatus = new Gauge({
      name: 'governance_retention_table_status',
      help: 'Table retention health (0=healthy, 1=warning, 2=critical)',
      labelNames: ['table'],
      registers: [this.registry],
    });

    // ── Consent ───────────────────────────────────────────────────────
    this.consentRate = new Gauge({
      name: 'governance_consent_rate',
      help: 'Effective consent rate (0-100%)',
      registers: [this.registry],
    });

    // ── DSAR ──────────────────────────────────────────────────────────
    this.dsarComplianceRate = new Gauge({
      name: 'governance_dsar_compliance_rate',
      help: 'DSAR compliance rate (0-100%)',
      registers: [this.registry],
    });

    // ── PII ───────────────────────────────────────────────────────────
    this.piiClassificationLevel = new Gauge({
      name: 'governance_pii_classification_level',
      help: 'PII classification level (0=PUBLIC, 1=INTERNAL, 2=CONFIDENTIAL, 3=RESTRICTED)',
      registers: [this.registry],
    });

    // ── Audit ─────────────────────────────────────────────────────────
    this.auditEntriesTotal = new Gauge({
      name: 'governance_audit_entries_total',
      help: 'Total audit entries in the current reporting window',
      registers: [this.registry],
    });

    // ── Performance ───────────────────────────────────────────────────
    this.evaluationDuration = new Histogram({
      name: 'governance_evaluation_duration_seconds',
      help: 'Duration of compliance evaluation in seconds',
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }

  /**
   * Record a compliance evaluation result.
   */
  recordEvaluation(
    overallScore: number,
    dimensions: {
      audit: AuditSummary;
      piiExposure: PiiExposureReport;
      retention: RetentionStatus;
      consent: ConsentOverview;
      protection: ProtectionSummary;
      dsar: DsarSummary;
    },
    alertResult?: { alerts: Array<{ severity: string; type: string }> },
    durationMs?: number,
  ): void {
    // ── Overall score ───────────────────────────────────────────────
    this.complianceScoreTotal.set(overallScore);

    // ── Sub-scores (derived from raw data) ──────────────────────────
    // Audit: 0 entries → 50, 100+ → 100
    const auditScore = Math.min(100, 50 + (dimensions.audit.totalEntries / 100) * 50);
    this.complianceScoreAudit.set(auditScore);

    // PII: classification → score
    const piiLevel = CLASSIFICATION_LEVEL[dimensions.piiExposure.overallClassification] ?? 0;
    const piiScore = Math.max(0, 100 - piiLevel * 25);
    this.complianceScorePii.set(piiScore);

    // Retention: healthy=100, warning=50, critical=0
    const retScore = RETENTION_STATUS[dimensions.retention.overallStatus] !== undefined
      ? (dimensions.retention.overallStatus === 'critical' ? 0
        : dimensions.retention.overallStatus === 'warning' ? 50
        : 100)
      : 100;
    this.complianceScoreRetention.set(retScore);

    // Consent: direct rate
    this.complianceScoreConsent.set(dimensions.consent.consentRate);

    // Security: verdict → score
    const secVerdictMap: Record<string, number> = { PASS: 0, WARN: 1, FAIL: 2 };
    const secScore = dimensions.protection.verdict === 'PASS' ? 100
      : dimensions.protection.verdict === 'WARN' ? 50
      : 0;
    this.complianceScoreSecurity.set(secScore);

    // DSAR: direct rate
    this.complianceScoreDsar.set(dimensions.dsar.complianceRate);

    // ── Security details ────────────────────────────────────────────
    this.securityRiskScore.set(dimensions.protection.riskScore);
    this.securityVerdict.set(secVerdictMap[dimensions.protection.verdict] ?? 0);

    // Reset findings by severity, then set.
    for (const sev of ['critical', 'high', 'medium', 'low', 'info'] as const) {
      this.securityFindings.set({ severity: sev }, dimensions.protection.bySeverity[sev] ?? 0);
    }

    // ── Retention details ───────────────────────────────────────────
    for (const table of dimensions.retention.tables) {
      this.retentionExpiredRecords.set({ table: table.table }, table.expiredRecords);
      this.retentionTableStatus.set({ table: table.table }, RETENTION_STATUS[table.status] ?? 0);
    }

    // ── Consent ─────────────────────────────────────────────────────
    this.consentRate.set(dimensions.consent.consentRate);

    // ── DSAR ────────────────────────────────────────────────────────
    this.dsarComplianceRate.set(dimensions.dsar.complianceRate);

    // ── PII ─────────────────────────────────────────────────────────
    this.piiClassificationLevel.set(piiLevel);

    // ── Audit ───────────────────────────────────────────────────────
    this.auditEntriesTotal.set(dimensions.audit.totalEntries);

    // ── Alerts ──────────────────────────────────────────────────────
    if (alertResult) {
      for (const alert of alertResult.alerts) {
        this.alertsFired.inc({ severity: alert.severity, type: alert.type });
      }
    }

    // ── Duration ────────────────────────────────────────────────────
    if (durationMs !== undefined) {
      this.evaluationDuration.observe(durationMs / 1000);
    }
  }

  /**
   * Set the alert cooldown gauge.
   */
  setAlertCooldown(cooldownMs: number): void {
    this.alertCooldownSeconds.set(cooldownMs / 1000);
  }

  /**
   * Record a single alert being fired (can be called independently).
   */
  recordAlert(severity: string, type: string): void {
    this.alertsFired.inc({ severity, type });
  }

  /**
   * Get the Prometheus text exposition format.
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get the content type for the /metrics endpoint.
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Get a single metric value (for testing/debugging).
   */
  async getMetricValue(name: string): Promise<number | null> {
    const metric = await this.registry.getSingleMetric(name);
    if (!metric) return null;
    const result = await metric.get();
    const values = result.values;
    if (values.length === 0) return null;
    return values[0].value;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: ComplianceMetrics | null = null;

/**
 * Get the singleton ComplianceMetrics instance.
 * Creates one if it doesn't exist.
 */
export function getComplianceMetrics(): ComplianceMetrics {
  if (!_instance) {
    _instance = new ComplianceMetrics();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetComplianceMetrics(): void {
  _instance = null;
}
