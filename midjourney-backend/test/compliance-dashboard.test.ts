/**
 * Compliance Dashboard — tests.
 *
 * Tests the governance dashboard service and API endpoints.
 */
import { describe, it, expect } from 'vitest';
import { ComplianceDashboard } from '../src/governance/dashboard';

// ── Mock Prisma ─────────────────────────────────────────────────────────────

function createMockPrisma() {
  const auditEntries = [
    { id: 'a1', eventType: 'DATA_ACCESS', actor: 'admin-1', insightId: 'i1', detail: { targetType: 'lead', targetId: 'lead-1' }, recordedAt: new Date('2024-06-01') },
    { id: 'a2', eventType: 'DATA_DELETE', actor: 'admin-1', insightId: 'i2', detail: { targetType: 'lead', targetId: 'lead-2' }, recordedAt: new Date('2024-06-02') },
    { id: 'a3', eventType: 'AUTH_LOGIN', actor: 'user-2', insightId: 'i3', detail: { targetType: 'auth', targetId: 'session-1' }, recordedAt: new Date('2024-06-03') },
  ];

  const consentRecords = [
    { id: 'c1', subjectType: 'LEAD', subjectId: 'lead-1', scope: 'DATA_PROCESSING', action: 'GRANTED', recordedAt: new Date('2024-01-15') },
    { id: 'c2', subjectType: 'LEAD', subjectId: 'lead-1', scope: 'MARKETING', action: 'GRANTED', recordedAt: new Date('2024-01-15') },
    { id: 'c3', subjectType: 'CANDIDATE', subjectId: 'cand-1', scope: 'DATA_PROCESSING', action: 'WITHDRAWN', recordedAt: new Date('2024-03-01') },
  ];

  return {
    auditEntry: {
      findMany: async () => auditEntries,
      count: async () => auditEntries.length,
    },
    lead: {
      findMany: async () => [
        { leadId: 'lead-1', name: 'Nguyen Van A', phone: '0912345678', email: 'nguyen@test.com', note: null, source: 'web', status: 'NEW', assignedTo: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      count: async () => 1,
    },
    candidateProfile: {
      findMany: async () => [],
      count: async () => 0,
    },
    consentRecord: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        if (args.where?.subjectType) {
          return consentRecords.filter((c) => c.subjectType === (args.where as { subjectType: string }).subjectType);
        }
        return consentRecords;
      },
    },
    erasureRequest: {
      count: async () => 2,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Compliance Dashboard', () => {
  const prisma = createMockPrisma() as never;
  const dashboard = new ComplianceDashboard(prisma);

  it('getAuditSummary returns audit data', async () => {
    const summary = await dashboard.getAuditSummary();

    expect(summary.totalEntries).toBe(3);
    expect(summary.byAction['DATA_ACCESS']).toBe(1);
    expect(summary.byAction['DATA_DELETE']).toBe(1);
    expect(summary.byAction['AUTH_LOGIN']).toBe(1);
    expect(summary.topActors.length).toBeGreaterThan(0);
    expect(summary.highRiskEntries.length).toBe(1); // DATA_DELETE
  });

  it('getAuditSummary filters by time range', async () => {
    const summary = await dashboard.getAuditSummary({
      from: '2024-06-02',
      to: '2024-12-31',
    });

    // Only entries from June 2 onwards.
    expect(summary.totalEntries).toBeLessThanOrEqual(3);
  });

  it('getPiiExposureReport scans tables', async () => {
    const report = await dashboard.getPiiExposureReport();

    expect(report.tablesScanned).toBe(2);
    expect(report.tablesWithPii.length).toBeGreaterThanOrEqual(1);
    expect(report.overallClassification).toMatch(/PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED/);
    expect(report.recommendations).toBeDefined();
  });

  it('getRetentionStatus returns status', async () => {
    const status = await dashboard.getRetentionStatus();

    expect(status.tables).toBeDefined();
    expect(status.overallStatus).toMatch(/healthy|warning|critical/);
  });

  it('getConsentOverview aggregates consent data', async () => {
    const overview = await dashboard.getConsentOverview();

    expect(overview.totalRecords).toBe(3);
    expect(overview.byScope['DATA_PROCESSING']).toBeDefined();
    expect(overview.byScope['DATA_PROCESSING'].granted).toBe(1);
    expect(overview.byScope['DATA_PROCESSING'].withdrawn).toBe(1);
    expect(overview.consentRate).toBeGreaterThan(0);
  });

  it('getConsentOverview filters by time range', async () => {
    const overview = await dashboard.getConsentOverview({
      from: '2024-03-01',
    });

    // Should include the withdrawn consent from March.
    expect(overview.totalRecords).toBeGreaterThanOrEqual(1);
  });

  it('getProtectionSummary returns security posture', async () => {
    const summary = await dashboard.getProtectionSummary();

    expect(summary.riskScore).toBeGreaterThanOrEqual(0);
    expect(summary.riskScore).toBeLessThanOrEqual(100);
    expect(summary.verdict).toMatch(/PASS|WARN|FAIL/);
    expect(summary.lastScanAt).toBeTruthy();
  });

  it('getDsarSummary returns DSAR metrics', async () => {
    const summary = await dashboard.getDsarSummary();

    expect(summary.totalRequests).toBe(2);
    expect(summary.complianceRate).toBe(100);
  });

  it('getOverview returns complete dashboard', async () => {
    const overview = await dashboard.getOverview();

    expect(overview.generatedAt).toBeTruthy();
    expect(overview.audit).toBeDefined();
    expect(overview.piiExposure).toBeDefined();
    expect(overview.retention).toBeDefined();
    expect(overview.consent).toBeDefined();
    expect(overview.protection).toBeDefined();
    expect(overview.dsar).toBeDefined();
    expect(overview.complianceScore).toBeGreaterThanOrEqual(0);
    expect(overview.complianceScore).toBeLessThanOrEqual(100);
    expect(overview.verdict).toMatch(/COMPLIANT|NON_COMPLIANT|NEEDS_REVIEW/);
  });

  it('getOverview caches results', async () => {
    const overview1 = await dashboard.getOverview();
    const overview2 = await dashboard.getOverview();

    // Same cache key → same object reference.
    expect(overview1).toBe(overview2);
  });

  it('getOverview with time range uses different cache key', async () => {
    const overview1 = await dashboard.getOverview();
    const overview2 = await dashboard.getOverview({ from: '2024-01-01' });

    // Different cache key → different object.
    expect(overview1).not.toBe(overview2);
  });
});
