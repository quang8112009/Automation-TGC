/**
 * Compliance Metrics — tests.
 *
 * Tests the ComplianceMetrics Prometheus collector:
 *   - Metric registration and default values
 *   - Score recording (overall + sub-scores)
 *   - Alert counter increments
 *   - Security finding gauges
 *   - Retention expired records per table
 *   - Consent rate and DSAR compliance
 *   - PII classification level
 *   - Evaluation duration histogram
 *   - Prometheus text exposition format
 *   - Singleton lifecycle
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComplianceMetrics, getComplianceMetrics, resetComplianceMetrics } from '../src/governance/metrics';
import type { AuditSummary, PiiExposureReport, RetentionStatus, ConsentOverview, ProtectionSummary, DsarSummary } from '../src/governance/dashboard';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDimensions(overrides: Partial<{
  audit: Partial<AuditSummary>;
  piiExposure: Partial<PiiExposureReport>;
  retention: Partial<RetentionStatus>;
  consent: Partial<ConsentOverview>;
  protection: Partial<ProtectionSummary>;
  dsar: Partial<DsarSummary>;
}> = {}) {
  return {
    audit: {
      totalEntries: 50,
      byAction: {},
      byRisk: {},
      byActor: {},
      byResourceType: {},
      daily: [],
      topActors: [],
      highRiskEntries: [],
      ...overrides.audit,
    } as AuditSummary,
    piiExposure: {
      tablesScanned: 0,
      tablesWithPii: [],
      piiTypeDistribution: {},
      overallClassification: 'INTERNAL',
      recommendations: [],
      ...overrides.piiExposure,
    } as PiiExposureReport,
    retention: {
      tables: [],
      overallStatus: 'healthy',
      nextPurgeRecommended: null,
      ...overrides.retention,
    } as RetentionStatus,
    consent: {
      totalRecords: 0,
      byScope: {},
      bySubjectType: {},
      consentRate: 95,
      recentChanges: [],
      ...overrides.consent,
    } as ConsentOverview,
    protection: {
      riskScore: 20,
      verdict: 'PASS',
      bySeverity: { critical: 0, high: 1, medium: 2, low: 3, info: 4 },
      criticalFindings: [],
      lastScanAt: new Date().toISOString(),
      ...overrides.protection,
    } as ProtectionSummary,
    dsar: {
      totalRequests: 0,
      bySubjectType: {},
      avgProcessingTimeMs: 0,
      complianceRate: 100,
      ...overrides.dsar,
    } as DsarSummary,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ComplianceMetrics', () => {
  let metrics: ComplianceMetrics;

  beforeEach(() => {
    metrics = new ComplianceMetrics();
  });

  // ── Overall score ──────────────────────────────────────────────────

  describe('overall score', () => {
    it('records overall compliance score', async () => {
      const dims = makeDimensions();
      metrics.recordEvaluation(85, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_total');
      expect(val).toBe(85);
    });

    it('updates score on successive evaluations', async () => {
      const dims = makeDimensions();
      metrics.recordEvaluation(90, dims);
      metrics.recordEvaluation(75, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_total');
      expect(val).toBe(75);
    });
  });

  // ── Sub-scores ─────────────────────────────────────────────────────

  describe('sub-scores', () => {
    it('computes audit sub-score from entry count', async () => {
      // 200 entries → audit score = min(100, 50 + (200/100)*50) = 100
      const dims = makeDimensions({ audit: { totalEntries: 200 } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_audit');
      expect(val).toBe(100);
    });

    it('computes PII sub-score from classification level', async () => {
      // RESTRICTED → level 3 → score = 100 - 3*25 = 25
      const dims = makeDimensions({ piiExposure: { overallClassification: 'RESTRICTED' } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_pii');
      expect(val).toBe(25);
    });

    it('computes retention sub-score from status', async () => {
      const dims = makeDimensions({ retention: { overallStatus: 'warning' } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_retention');
      expect(val).toBe(50);
    });

    it('records consent sub-score directly', async () => {
      const dims = makeDimensions({ consent: { consentRate: 88 } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_consent');
      expect(val).toBe(88);
    });

    it('computes security sub-score from verdict', async () => {
      const dims = makeDimensions({ protection: { verdict: 'FAIL' } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_security');
      expect(val).toBe(0);
    });

    it('records DSAR sub-score directly', async () => {
      const dims = makeDimensions({ dsar: { complianceRate: 75 } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_compliance_score_dsar');
      expect(val).toBe(75);
    });
  });

  // ── Alerts ─────────────────────────────────────────────────────────

  describe('alerts', () => {
    it('increments alert counter by severity and type', async () => {
      const dims = makeDimensions();
      metrics.recordEvaluation(100, dims, {
        alerts: [
          { severity: 'critical', type: 'SCORE_DROP' },
          { severity: 'warning', type: 'CONSENT_LOW' },
          { severity: 'critical', type: 'SCORE_DROP' },
        ],
      });
      // Counter should have incremented for each alert.
      const output = await metrics.getMetrics();
      expect(output).toContain('governance_compliance_alerts_total');
    });

    it('records single alert via recordAlert', async () => {
      metrics.recordAlert('info', 'DSAR_NONCOMPLIANT');
      const output = await metrics.getMetrics();
      expect(output).toContain('governance_compliance_alerts_total');
    });
  });

  // ── Security ───────────────────────────────────────────────────────

  describe('security', () => {
    it('records security risk score', async () => {
      const dims = makeDimensions({ protection: { riskScore: 75 } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_security_risk_score');
      expect(val).toBe(75);
    });

    it('records security verdict (PASS=0, WARN=1, FAIL=2)', async () => {
      const dims = makeDimensions({ protection: { verdict: 'FAIL' } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_security_verdict');
      expect(val).toBe(2);
    });

    it('records findings by severity', async () => {
      const dims = makeDimensions({
        protection: { bySeverity: { critical: 3, high: 5, medium: 2, low: 1, info: 0 } },
      });
      metrics.recordEvaluation(100, dims);
      const output = await metrics.getMetrics();
      expect(output).toContain('governance_security_findings_total');
    });
  });

  // ── Retention ──────────────────────────────────────────────────────

  describe('retention', () => {
    it('records expired records per table', async () => {
      const dims = makeDimensions({
        retention: {
          tables: [
            { table: 'Lead', totalRecords: 1000, expiredRecords: 250, retentionPeriod: '24_months', lastPurgeDate: null, status: 'warning' },
            { table: 'AuditEntry', totalRecords: 5000, expiredRecords: 0, retentionPeriod: '12_months', lastPurgeDate: null, status: 'healthy' },
          ],
        },
      });
      metrics.recordEvaluation(100, dims);
      const output = await metrics.getMetrics();
      expect(output).toContain('governance_retention_expired_total');
    });

    it('records table status (healthy=0, warning=1, critical=2)', async () => {
      const dims = makeDimensions({
        retention: {
          tables: [
            { table: 'Lead', totalRecords: 100, expiredRecords: 5000, retentionPeriod: '24_months', lastPurgeDate: null, status: 'critical' },
          ],
        },
      });
      metrics.recordEvaluation(100, dims);
      const output = await metrics.getMetrics();
      expect(output).toContain('governance_retention_table_status');
    });
  });

  // ── Consent & DSAR ─────────────────────────────────────────────────

  describe('consent & DSAR', () => {
    it('records consent rate', async () => {
      const dims = makeDimensions({ consent: { consentRate: 92 } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_consent_rate');
      expect(val).toBe(92);
    });

    it('records DSAR compliance rate', async () => {
      const dims = makeDimensions({ dsar: { complianceRate: 88 } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_dsar_compliance_rate');
      expect(val).toBe(88);
    });
  });

  // ── PII ────────────────────────────────────────────────────────────

  describe('PII', () => {
    it('records PII classification level as numeric', async () => {
      const dims = makeDimensions({ piiExposure: { overallClassification: 'CONFIDENTIAL' } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_pii_classification_level');
      expect(val).toBe(2); // CONFIDENTIAL = 2
    });
  });

  // ── Audit ──────────────────────────────────────────────────────────

  describe('audit', () => {
    it('records total audit entries', async () => {
      const dims = makeDimensions({ audit: { totalEntries: 300 } });
      metrics.recordEvaluation(100, dims);
      const val = await metrics.getMetricValue('governance_audit_entries_total');
      expect(val).toBe(300);
    });
  });

  // ── Duration ───────────────────────────────────────────────────────

  describe('evaluation duration', () => {
    it('records evaluation duration in seconds', async () => {
      const dims = makeDimensions();
      metrics.recordEvaluation(100, dims, undefined, 150); // 150ms = 0.15s
      const output = await metrics.getMetrics();
      expect(output).toContain('governance_evaluation_duration_seconds');
    });
  });

  // ── Alert cooldown ─────────────────────────────────────────────────

  describe('alert cooldown', () => {
    it('sets alert cooldown in seconds', async () => {
      metrics.setAlertCooldown(14400000); // 4 hours in ms
      const val = await metrics.getMetricValue('governance_alert_cooldown_seconds');
      expect(val).toBe(14400);
    });
  });

  // ── Prometheus format ──────────────────────────────────────────────

  describe('Prometheus format', () => {
    it('returns valid Prometheus text format', async () => {
      const dims = makeDimensions();
      metrics.recordEvaluation(85, dims);
      const text = await metrics.getMetrics();
      expect(text).toContain('governance_compliance_score_total');
      expect(text).toContain('85');
      expect(text).toContain('# HELP');
      expect(text).toContain('# TYPE');
    });

    it('returns correct content type', () => {
      const ct = metrics.getContentType();
      expect(ct).toContain('text/plain');
    });
  });

  // ── Singleton ──────────────────────────────────────────────────────

  describe('singleton', () => {
    beforeEach(() => {
      resetComplianceMetrics();
    });

    it('returns same instance from getComplianceMetrics', () => {
      const a = getComplianceMetrics();
      const b = getComplianceMetrics();
      expect(a).toBe(b);
    });

    it('creates new instance after reset', () => {
      const a = getComplianceMetrics();
      resetComplianceMetrics();
      const b = getComplianceMetrics();
      expect(a).not.toBe(b);
    });
  });
});
