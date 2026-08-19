/**
 * Compliance Export — tests.
 *
 * Tests the CSV and PDF export functionality for compliance reports.
 */
import { describe, it, expect } from 'vitest';
import { exportComplianceCSV, exportCompliancePDF } from '../src/governance/export';
import type { ComplianceDashboardOverview, AuditSummary, PiiExposureReport, RetentionStatus, ConsentOverview, ProtectionSummary, DsarSummary } from '../src/governance/dashboard';

// ── Mock Data ────────────────────────────────────────────────────────────────

const mockOverview: ComplianceDashboardOverview = {
  generatedAt: '2026-08-20T00:00:00.000Z',
  timeRange: {},
  audit: {
    totalEntries: 100,
    byAction: { DATA_ACCESS: 50, DATA_UPDATE: 30, DATA_DELETE: 10, AUTH_LOGIN: 10 },
    byRisk: {},
    byActor: { 'admin-1': 40, 'user-2': 60 },
    byResourceType: { lead: 70, candidate: 30 },
    daily: [],
    topActors: [],
    highRiskEntries: [],
  },
  piiExposure: {
    tablesScanned: 5,
    tablesWithPii: [
      { table: 'Lead', piiTypes: ['EMAIL', 'PHONE_VN'], recordCount: 100, classificationLevel: 'CONFIDENTIAL' },
      { table: 'CandidateProfile', piiTypes: ['EMAIL', 'PHONE_VN', 'CCCD'], recordCount: 50, classificationLevel: 'RESTRICTED' },
    ],
    piiTypeDistribution: { EMAIL: 150, PHONE_VN: 120, CCCD: 50 },
    overallClassification: 'CONFIDENTIAL',
    recommendations: ['Encrypt PII fields at rest', 'Add access logging'],
  },
  retention: {
    tables: [
      { table: 'Lead', totalRecords: 1000, expiredRecords: 100, retentionPeriod: '24_months', lastPurgeDate: null, status: 'warning' },
      { table: 'AuditEntry', totalRecords: 5000, expiredRecords: 0, retentionPeriod: '12_months', lastPurgeDate: null, status: 'healthy' },
    ],
    overallStatus: 'warning',
    nextPurgeRecommended: '2026-08-21T00:00:00.000Z',
  },
  consent: {
    totalRecords: 200,
    byScope: {
      DATA_PROCESSING: { granted: 150, withdrawn: 10 },
      MARKETING: { granted: 100, withdrawn: 40 },
    },
    bySubjectType: { LEAD: 150, CANDIDATE: 50 },
    consentRate: 85,
    recentChanges: [],
  },
  protection: {
    riskScore: 25,
    verdict: 'PASS',
    bySeverity: { critical: 0, high: 1, medium: 3, low: 5, info: 10 },
    criticalFindings: [],
    lastScanAt: '2026-08-20T00:00:00.000Z',
  },
  dsar: {
    totalRequests: 2,
    bySubjectType: {},
    avgProcessingTimeMs: 5000,
    complianceRate: 100,
  },
  complianceScore: 82,
  verdict: 'COMPLIANT',
};

const mockAlerts = [
  {
    id: 'alert-1',
    severity: 'warning' as const,
    type: 'SCORE_DROP' as const,
    title: 'Compliance score WARNING: 82/100',
    message: 'Score dropped to 82',
    score: 82,
    channels: ['slack'],
    sentAt: '2026-08-20T00:00:00.000Z',
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Compliance Export', () => {
  // ── CSV Export ──────────────────────────────────────────────────────

  describe('CSV export', () => {
    it('exports full report as CSV', () => {
      const result = exportComplianceCSV(mockOverview, 'all', mockAlerts);
      expect(result.extension).toBe('csv');
      expect(result.mimeType).toContain('text/csv');
      expect(result.filename).toMatch(/^compliance-report-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(result.content).toContain('Compliance Report');
      expect(result.content).toContain('Score: 82/100');
      expect(result.content).toContain('AUDIT SUMMARY');
      expect(result.content).toContain('PII EXPOSURE');
      expect(result.content).toContain('DATA RETENTION');
      expect(result.content).toContain('CONSENT MANAGEMENT');
      expect(result.content).toContain('SECURITY PROTECTION');
      expect(result.content).toContain('DSAR COMPLIANCE');
    });

    it('exports audit section only', () => {
      const result = exportComplianceCSV(mockOverview, 'audit');
      expect(result.content).toContain('AUDIT SUMMARY');
      expect(result.content).toContain('DATA_ACCESS');
      expect(result.content).not.toContain('PII EXPOSURE');
    });

    it('exports PII section only', () => {
      const result = exportComplianceCSV(mockOverview, 'pii');
      expect(result.content).toContain('PII EXPOSURE');
      expect(result.content).toContain('Lead');
      expect(result.content).toContain('CandidateProfile');
    });

    it('exports retention section only', () => {
      const result = exportComplianceCSV(mockOverview, 'retention');
      expect(result.content).toContain('DATA RETENTION');
      expect(result.content).toContain('Lead');
    });

    it('exports alerts in CSV', () => {
      const result = exportComplianceCSV(mockOverview, 'all', mockAlerts);
      expect(result.content).toContain('ALERT HISTORY');
      expect(result.content).toContain('alert-1');
      expect(result.content).toContain('Compliance score WARNING');
    });

    it('handles empty alerts', () => {
      const result = exportComplianceCSV(mockOverview, 'all', []);
      expect(result.content).not.toContain('ALERT HISTORY');
    });
  });

  // ── PDF Export ─────────────────────────────────────────────────────

  describe('PDF export', () => {
    it('exports full report as PDF', async () => {
      const result = await exportCompliancePDF(mockOverview, mockAlerts);
      expect(result.extension).toBe('pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toMatch(/^compliance-report-\d{4}-\d{2}-\d{2}\.pdf$/);
      expect(Buffer.isBuffer(result.content)).toBe(true);
      // PDF header: %PDF
      expect(result.content.slice(0, 4).toString()).toBe('%PDF');
    });

    it('exports PDF without alerts', async () => {
      const result = await exportCompliancePDF(mockOverview);
      expect(result.extension).toBe('pdf');
      expect(Buffer.isBuffer(result.content)).toBe(true);
    });

    it('PDF file size is reasonable (> 1KB)', async () => {
      const result = await exportCompliancePDF(mockOverview);
      expect(result.content.length).toBeGreaterThan(1024);
    });
  });
});
