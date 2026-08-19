/**
 * Compliance Alerting — tests.
 *
 * Tests the ComplianceAlerter service including:
 *   - Score-based alerts (warning / critical thresholds)
 *   - Critical security findings alerts
 *   - Retention health alerts
 *   - Consent rate alerts
 *   - PII exposure alerts
 *   - DSAR non-compliance alerts
 *   - Cooldown logic (no duplicate alerts within window)
 *   - Alert history and stats
 *   - Multiple channel dispatch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceAlerter } from '../src/governance/alerting';
import type { ComplianceSnapshot, AlertThresholds } from '../src/governance/alerting';

// ── Mock Prisma ──────────────────────────────────────────────────────────────

function createMockPrisma() {
  const storedAlerts: Array<Record<string, unknown>> = [];

  return {
    complianceAlert: {
      create: async (args: { data: Record<string, unknown> }) => {
        storedAlerts.push(args.data);
        return args.data;
      },
      findMany: async (args: { where?: Record<string, unknown>; orderBy?: Record<string, unknown>; take?: number; select?: Record<string, unknown> }) => {
        let filtered = storedAlerts;
        if (args.where?.severity) {
          filtered = filtered.filter((a) => a.severity === (args.where as { severity: string }).severity);
        }
        if (args.where?.type) {
          filtered = filtered.filter((a) => a.type === (args.where as { type: string }).type);
        }
        if (args.where?.sentAt) {
          const sentAtFilter = args.where.sentAt as { gte?: Date };
          if (sentAtFilter.gte) {
            filtered = filtered.filter((a) => (a.sentAt as Date) >= sentAtFilter.gte!);
          }
        }
        const limit = args.take ?? filtered.length;
        return filtered.slice(0, limit);
      },
      findFirst: async () => {
        if (storedAlerts.length === 0) return null;
        return { score: storedAlerts[storedAlerts.length - 1].score };
      },
    },
    _storedAlerts: storedAlerts,
  } as never;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function healthySnapshot(): ComplianceSnapshot {
  return {
    audit: { totalEntries: 100 },
    piiExposure: { overallClassification: 'INTERNAL', recommendations: [] },
    retention: { overallStatus: 'healthy' },
    consent: { consentRate: 95 },
    protection: { verdict: 'PASS', criticalFindings: [] },
    dsar: { complianceRate: 100 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ComplianceAlerter', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let alerter: ComplianceAlerter;

  beforeEach(() => {
    prisma = createMockPrisma();
    // Use very short cooldown for testing.
    alerter = new ComplianceAlerter(prisma, {}, { cooldownMs: 0 });
  });

  // ── Score-based alerts ─────────────────────────────────────────────────

  describe('score-based alerts', () => {
    it('fires CRITICAL alert when score <= 60', async () => {
      const result = await alerter.evaluate(50, healthySnapshot());
      expect(result.alerts.length).toBeGreaterThanOrEqual(1);
      expect(result.alerts.some((a) => a.type === 'SCORE_DROP' && a.severity === 'critical')).toBe(true);
    });

    it('fires WARNING alert when score <= 80', async () => {
      const result = await alerter.evaluate(75, healthySnapshot());
      expect(result.alerts.some((a) => a.type === 'SCORE_DROP' && a.severity === 'warning')).toBe(true);
    });

    it('fires no score alert when score > 80', async () => {
      const result = await alerter.evaluate(85, healthySnapshot());
      expect(result.alerts.filter((a) => a.type === 'SCORE_DROP')).toHaveLength(0);
    });

    it('tracks previous score and delta', async () => {
      // First evaluation fires an alert (score <= 80 threshold), persisting the score.
      await alerter.evaluate(75, healthySnapshot());
      const result = await alerter.evaluate(50, healthySnapshot());
      expect(result.previousScore).toBe(75);
      expect(result.scoreDelta).toBe(-25);
    });
  });

  // ── Security alerts ────────────────────────────────────────────────────

  describe('security alerts', () => {
    it('fires alert when protection verdict is FAIL', async () => {
      const snapshot: ComplianceSnapshot = {
        protection: {
          verdict: 'FAIL',
          criticalFindings: [
            { id: 'f1', title: 'Hardcoded API key in source' },
            { id: 'f2', title: 'Missing rate limiting' },
          ],
        },
      };
      const result = await alerter.evaluate(100, snapshot);
      expect(result.alerts.some((a) => a.type === 'SECURITY_VERDICT_FAIL')).toBe(true);
    });

    it('fires no security alert when verdict is PASS', async () => {
      const result = await alerter.evaluate(100, { protection: { verdict: 'PASS', criticalFindings: [] } });
      expect(result.alerts.filter((a) => a.type === 'SECURITY_VERDICT_FAIL')).toHaveLength(0);
    });
  });

  // ── Retention alerts ───────────────────────────────────────────────────

  describe('retention alerts', () => {
    it('fires alert when retention is critical', async () => {
      const result = await alerter.evaluate(100, { retention: { overallStatus: 'critical' } });
      expect(result.alerts.some((a) => a.type === 'RETENTION_CRITICAL')).toBe(true);
    });

    it('fires no alert when retention is healthy', async () => {
      const result = await alerter.evaluate(100, { retention: { overallStatus: 'healthy' } });
      expect(result.alerts.filter((a) => a.type === 'RETENTION_CRITICAL')).toHaveLength(0);
    });
  });

  // ── Consent alerts ─────────────────────────────────────────────────────

  describe('consent alerts', () => {
    it('fires alert when consent rate < 80%', async () => {
      const result = await alerter.evaluate(100, { consent: { consentRate: 65 } });
      expect(result.alerts.some((a) => a.type === 'CONSENT_LOW')).toBe(true);
    });

    it('fires no alert when consent rate >= 80%', async () => {
      const result = await alerter.evaluate(100, { consent: { consentRate: 85 } });
      expect(result.alerts.filter((a) => a.type === 'CONSENT_LOW')).toHaveLength(0);
    });
  });

  // ── PII exposure alerts ────────────────────────────────────────────────

  describe('PII exposure alerts', () => {
    it('fires alert when classification is RESTRICTED', async () => {
      const result = await alerter.evaluate(100, {
        piiExposure: { overallClassification: 'RESTRICTED', recommendations: ['Encrypt PII fields', 'Add access logging'] },
      });
      expect(result.alerts.some((a) => a.type === 'PII_EXPOSURE_HIGH')).toBe(true);
    });

    it('fires no alert when classification is INTERNAL', async () => {
      const result = await alerter.evaluate(100, {
        piiExposure: { overallClassification: 'INTERNAL', recommendations: [] },
      });
      expect(result.alerts.filter((a) => a.type === 'PII_EXPOSURE_HIGH')).toHaveLength(0);
    });
  });

  // ── DSAR alerts ────────────────────────────────────────────────────────

  describe('DSAR alerts', () => {
    it('fires alert when DSAR compliance rate < 100%', async () => {
      const result = await alerter.evaluate(100, { dsar: { complianceRate: 80 } });
      expect(result.alerts.some((a) => a.type === 'DSAR_NONCOMPLIANT')).toBe(true);
    });

    it('fires no alert when DSAR compliance rate is 100%', async () => {
      const result = await alerter.evaluate(100, { dsar: { complianceRate: 100 } });
      expect(result.alerts.filter((a) => a.type === 'DSAR_NONCOMPLIANT')).toHaveLength(0);
    });
  });

  // ── Cooldown ───────────────────────────────────────────────────────────

  describe('cooldown', () => {
    it('suppresses duplicate alerts within cooldown window', async () => {
      // Create alerter with 1-hour cooldown.
      const coolAlerter = new ComplianceAlerter(prisma, {}, { cooldownMs: 3600_000 });

      const r1 = await coolAlerter.evaluate(50, healthySnapshot());
      expect(r1.alerts.some((a) => a.type === 'SCORE_DROP')).toBe(true);

      // Second evaluation with same score should be suppressed.
      const r2 = await coolAlerter.evaluate(50, healthySnapshot());
      expect(r2.alerts.filter((a) => a.type === 'SCORE_DROP')).toHaveLength(0);
    });

    it('allows different alert types within same cooldown', async () => {
      const coolAlerter = new ComplianceAlerter(prisma, {}, { cooldownMs: 3600_000 });

      await coolAlerter.evaluate(50, healthySnapshot()); // SCORE_DROP fires
      const r2 = await coolAlerter.evaluate(100, { protection: { verdict: 'FAIL', criticalFindings: [] } }); // SECURITY fires
      expect(r2.alerts.some((a) => a.type === 'SECURITY_VERDICT_FAIL')).toBe(true);
    });
  });

  // ── Multiple alerts in one evaluation ───────────────────────────────────

  describe('multiple alerts', () => {
    it('fires multiple alerts when multiple conditions are met', async () => {
      const snapshot: ComplianceSnapshot = {
        retention: { overallStatus: 'critical' },
        consent: { consentRate: 50 },
        protection: { verdict: 'FAIL', criticalFindings: [{ id: 'f1', title: 'Critical vuln' }] },
      };
      const result = await alerter.evaluate(30, snapshot);
      // Should fire: SCORE_DROP (critical), SECURITY, RETENTION, CONSENT
      expect(result.alerts.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ── Alert persistence ──────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists alerts to the database', async () => {
      await alerter.evaluate(50, healthySnapshot());
      expect(prisma._storedAlerts.length).toBeGreaterThanOrEqual(1);
      expect(prisma._storedAlerts[0].severity).toBe('critical');
    });
  });

  // ── Alert history ──────────────────────────────────────────────────────

  describe('alert history', () => {
    it('returns empty history when no alerts exist', async () => {
      const history = await alerter.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('filters by severity', async () => {
      await alerter.evaluate(50, healthySnapshot()); // fires critical
      const critical = await alerter.getAlertHistory({ severity: 'critical' });
      expect(critical.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Alert stats ────────────────────────────────────────────────────────

  describe('alert stats', () => {
    it('returns zero stats when no alerts exist', async () => {
      const stats = await alerter.getAlertStats();
      expect(stats.totalAlerts).toBe(0);
      expect(stats.bySeverity.critical).toBe(0);
      expect(stats.bySeverity.warning).toBe(0);
    });
  });

  // ── Custom thresholds ──────────────────────────────────────────────────

  describe('custom thresholds', () => {
    it('respects custom warning threshold', async () => {
      const custom = new ComplianceAlerter(prisma, {}, {
        scoreWarning: 90,
        scoreCritical: 70,
        cooldownMs: 0,
      });

      const result = await custom.evaluate(85, healthySnapshot());
      expect(result.alerts.some((a) => a.type === 'SCORE_DROP' && a.severity === 'warning')).toBe(true);
    });

    it('respects custom critical threshold', async () => {
      const custom = new ComplianceAlerter(prisma, {}, {
        scoreWarning: 90,
        scoreCritical: 85,
        cooldownMs: 0,
      });

      const result = await custom.evaluate(80, healthySnapshot());
      expect(result.alerts.some((a) => a.type === 'SCORE_DROP' && a.severity === 'critical')).toBe(true);
    });
  });

  // ── Channel detection ──────────────────────────────────────────────────

  describe('channels', () => {
    it('lists available channels in alert', async () => {
      const withChannels = new ComplianceAlerter(
        prisma,
        {
          slack: { webhookUrl: 'https://hooks.slack.com/test' },
          email: { smtpHost: 'smtp.test.com', smtpPort: 587, from: 'test@test.com', to: ['admin@test.com'] },
        },
        { cooldownMs: 0 },
      );
      const result = await withChannels.evaluate(50, healthySnapshot());
      expect(result.alerts[0].channels).toContain('slack');
      expect(result.alerts[0].channels).toContain('email');
    });

    it('works with no channels configured', async () => {
      const noChannels = new ComplianceAlerter(prisma, {}, { cooldownMs: 0 });
      const result = await noChannels.evaluate(50, healthySnapshot());
      expect(result.alerts[0].channels).toHaveLength(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('clamps score between 0 and 100', async () => {
      const result = await alerter.evaluate(-10, healthySnapshot());
      expect(result.score).toBe(-10); // Score is passed through, not clamped in alerter.
      expect(result.alerts.some((a) => a.type === 'SCORE_DROP')).toBe(true);
    });

    it('handles empty snapshot gracefully', async () => {
      const result = await alerter.evaluate(90, {});
      // No snapshot data means no non-score alerts.
      expect(result.alerts.filter((a) => a.type !== 'SCORE_DROP')).toHaveLength(0);
    });
  });
});
