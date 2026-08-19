/**
 * governance/export — Compliance report export to CSV and PDF.
 *
 * Exports the compliance dashboard data in downloadable formats:
 *   - CSV: Audit trail, PII exposure, retention status, alerts
 *   - PDF: Executive summary with charts and recommendations
 *
 * USAGE:
 *   import { exportComplianceCSV, exportCompliancePDF } from '../governance/export';
 *   const csv = await exportComplianceCSV(dashboard);
 *   const pdf = await exportCompliancePDF(dashboard);
 */
import PDFDocument from 'pdfkit';
import type { ComplianceDashboardOverview } from './dashboard';
import type { AuditSummary, PiiExposureReport, RetentionStatus, ConsentOverview, ProtectionSummary, DsarSummary } from './dashboard';
import type { AlertHistoryEntry } from './alerting';

// ── Types ────────────────────────────────────────────────────────────────────

/** Export result with content and metadata. */
export interface ExportResult {
  /** File content (string for CSV, Buffer for PDF). */
  content: string | Buffer;
  /** MIME type. */
  mimeType: string;
  /** File extension. */
  extension: string;
  /** Suggested filename. */
  filename: string;
}

/** Export format options. */
export type ExportFormat = 'csv' | 'pdf';

/** CSV section options. */
export type CSVSection = 'audit' | 'pii' | 'retention' | 'consent' | 'protection' | 'dsar' | 'all';

// ── CSV Export ───────────────────────────────────────────────────────────────

/**
 * Export audit summary to CSV.
 */
function auditToCSV(audit: AuditSummary): string {
  const lines: string[] = ['Action,Count,Percentage'];
  const total = audit.totalEntries || 1;
  for (const [action, count] of Object.entries(audit.byAction)) {
    lines.push(`${action},${count},${((count / total) * 100).toFixed(1)}%`);
  }
  lines.push('');
  lines.push('Actor,Count');
  for (const [actor, count] of Object.entries(audit.byActor)) {
    lines.push(`${actor},${count}`);
  }
  return lines.join('\n');
}

/**
 * Export PII exposure to CSV.
 */
function piiToCSV(pii: PiiExposureReport): string {
  const lines: string[] = ['Table,PII Types,Record Count,Classification'];
  for (const table of pii.tablesWithPii) {
    lines.push(`${table.table},"${table.piiTypes.join('; ')}",${table.recordCount},${table.classificationLevel}`);
  }
  lines.push('');
  lines.push('PII Type,Count');
  for (const [type, count] of Object.entries(pii.piiTypeDistribution)) {
    lines.push(`${type},${count}`);
  }
  return lines.join('\n');
}

/**
 * Export retention status to CSV.
 */
function retentionToCSV(retention: RetentionStatus): string {
  const lines: string[] = ['Table,Total Records,Expired Records,Retention Period,Status'];
  for (const table of retention.tables) {
    lines.push(`${table.table},${table.totalRecords},${table.expiredRecords},${table.retentionPeriod},${table.status}`);
  }
  return lines.join('\n');
}

/**
 * Export consent overview to CSV.
 */
function consentToCSV(consent: ConsentOverview): string {
  const lines: string[] = ['Scope,Granted,Withdrawn,Total'];
  for (const [scope, data] of Object.entries(consent.byScope)) {
    lines.push(`${scope},${data.granted},${data.withdrawn},${data.granted + data.withdrawn}`);
  }
  lines.push('');
  lines.push(`Overall Consent Rate,${consent.consentRate}%`);
  return lines.join('\n');
}

/**
 * Export protection report to CSV.
 */
function protectionToCSV(protection: ProtectionSummary): string {
  const lines: string[] = ['Metric,Value'];
  lines.push(`Risk Score,${protection.riskScore}`);
  lines.push(`Verdict,${protection.verdict}`);
  lines.push('');
  lines.push('Severity,Count');
  for (const [severity, count] of Object.entries(protection.bySeverity)) {
    lines.push(`${severity},${count}`);
  }
  return lines.join('\n');
}

/**
 * Export DSAR summary to CSV.
 */
function dsarToCSV(dsar: DsarSummary): string {
  const lines: string[] = ['Metric,Value'];
  lines.push(`Total Requests,${dsar.totalRequests}`);
  lines.push(`Compliance Rate,${dsar.complianceRate}%`);
  lines.push(`Avg Processing Time,${dsar.avgProcessingTimeMs}ms`);
  return lines.join('\n');
}

/**
 * Export alerts to CSV.
 */
function alertsToCSV(alerts: AlertHistoryEntry[]): string {
  const lines: string[] = ['ID,Severity,Type,Title,Score,Channels,Sent At'];
  for (const alert of alerts) {
    lines.push(`${alert.id},${alert.severity},${alert.type},"${alert.title}",${alert.score},"${alert.channels.join('; ')}",${alert.sentAt}`);
  }
  return lines.join('\n');
}

/**
 * Export compliance report to CSV.
 *
 * @param overview - The compliance dashboard overview
 * @param section - Which section to export (default: 'all')
 * @param alerts - Optional alert history to include
 */
export function exportComplianceCSV(
  overview: ComplianceDashboardOverview,
  section: CSVSection = 'all',
  alerts?: AlertHistoryEntry[],
): ExportResult {
  const parts: string[] = [];

  // Header
  parts.push('Compliance Report');
  parts.push(`Generated: ${overview.generatedAt}`);
  parts.push(`Score: ${overview.complianceScore}/100`);
  parts.push(`Verdict: ${overview.verdict}`);
  parts.push('');

  if (section === 'all' || section === 'audit') {
    parts.push('=== AUDIT SUMMARY ===');
    parts.push(auditToCSV(overview.audit));
    parts.push('');
  }

  if (section === 'all' || section === 'pii') {
    parts.push('=== PII EXPOSURE ===');
    parts.push(piiToCSV(overview.piiExposure));
    parts.push('');
  }

  if (section === 'all' || section === 'retention') {
    parts.push('=== DATA RETENTION ===');
    parts.push(retentionToCSV(overview.retention));
    parts.push('');
  }

  if (section === 'all' || section === 'consent') {
    parts.push('=== CONSENT MANAGEMENT ===');
    parts.push(consentToCSV(overview.consent));
    parts.push('');
  }

  if (section === 'all' || section === 'protection') {
    parts.push('=== SECURITY PROTECTION ===');
    parts.push(protectionToCSV(overview.protection));
    parts.push('');
  }

  if (section === 'all' || section === 'dsar') {
    parts.push('=== DSAR COMPLIANCE ===');
    parts.push(dsarToCSV(overview.dsar));
    parts.push('');
  }

  if (alerts && alerts.length > 0) {
    parts.push('=== ALERT HISTORY ===');
    parts.push(alertsToCSV(alerts));
    parts.push('');
  }

  const content = parts.join('\n');
  const date = new Date().toISOString().slice(0, 10);

  return {
    content,
    mimeType: 'text/csv; charset=utf-8',
    extension: 'csv',
    filename: `compliance-report-${date}.csv`,
  };
}

// ── PDF Export ───────────────────────────────────────────────────────────────

/**
 * Create a styled PDF document with compliance report.
 */
export async function exportCompliancePDF(
  overview: ComplianceDashboardOverview,
  alerts?: AlertHistoryEntry[],
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: {
          Title: 'Compliance Report',
          Author: 'AutoTGC Governance Platform',
          CreationDate: new Date(),
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const date = new Date().toISOString().slice(0, 10);
        resolve({
          content: buffer,
          mimeType: 'application/pdf',
          extension: 'pdf',
          filename: `compliance-report-${date}.pdf`,
        });
      });
      doc.on('error', reject);

      // ── Title Page ────────────────────────────────────────────────
      doc.fontSize(24).text('Compliance Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#666').text(`Generated: ${overview.generatedAt}`, { align: 'center' });
      doc.moveDown(1);

      // Score box
      const scoreColor = overview.complianceScore >= 80 ? '#28a745'
        : overview.complianceScore >= 50 ? '#ffc107' : '#dc3545';
      doc.rect(200, doc.y, 195, 60).fillAndStroke(scoreColor, scoreColor);
      doc.fontSize(36).fillColor('#fff').text(`${overview.complianceScore}`, 200, doc.y - 50, { align: 'center', width: 195 });
      doc.fontSize(14).text('COMPLIANCE SCORE', 200, doc.y - 5, { align: 'center', width: 195 });
      doc.moveDown(2);

      // Verdict
      doc.fontSize(14).fillColor('#333').text(`Verdict: ${overview.verdict}`, { align: 'center' });
      doc.moveDown(2);

      // ── Section: Audit Summary ────────────────────────────────────
      doc.fontSize(16).fillColor('#333').text('1. Audit Summary');
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555');
      doc.text(`Total Entries: ${overview.audit.totalEntries}`);
      doc.moveDown(0.3);

      // Top actions table
      const auditEntries = Object.entries(overview.audit.byAction)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10);
      if (auditEntries.length > 0) {
        doc.fontSize(11).fillColor('#333').text('Top Actions:');
        for (const [action, count] of auditEntries) {
          doc.fontSize(10).fillColor('#555').text(`  ${action}: ${count}`);
        }
      }
      doc.moveDown(1);

      // ── Section: PII Exposure ────────────────────────────────────
      doc.fontSize(16).fillColor('#333').text('2. PII Exposure');
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555');
      doc.text(`Classification Level: ${overview.piiExposure.overallClassification}`);
      doc.text(`Tables Scanned: ${overview.piiExposure.tablesScanned}`);
      doc.text(`Tables with PII: ${overview.piiExposure.tablesWithPii.length}`);
      if (overview.piiExposure.recommendations.length > 0) {
        doc.moveDown(0.3);
        doc.text('Recommendations:');
        for (const rec of overview.piiExposure.recommendations) {
          doc.fontSize(10).fillColor('#555').text(`  • ${rec}`);
        }
      }
      doc.moveDown(1);

      // ── Section: Data Retention ──────────────────────────────────
      doc.fontSize(16).fillColor('#333').text('3. Data Retention');
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555');
      doc.text(`Overall Status: ${overview.retention.overallStatus}`);
      doc.moveDown(0.3);
      for (const table of overview.retention.tables) {
        const statusIcon = table.status === 'healthy' ? '✓' : table.status === 'warning' ? '⚠' : '✗';
        doc.fontSize(10).fillColor('#555').text(`  ${statusIcon} ${table.table}: ${table.totalRecords} records (${table.expiredRecords} expired)`);
      }
      doc.moveDown(1);

      // ── Section: Consent ─────────────────────────────────────────
      doc.fontSize(16).fillColor('#333').text('4. Consent Management');
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555');
      doc.text(`Consent Rate: ${overview.consent.consentRate}%`);
      doc.moveDown(0.3);
      for (const [scope, data] of Object.entries(overview.consent.byScope)) {
        doc.fontSize(10).fillColor('#555').text(`  ${scope}: ${data.granted} granted / ${data.withdrawn} withdrawn`);
      }
      doc.moveDown(1);

      // ── Section: Security ────────────────────────────────────────
      doc.fontSize(16).fillColor('#333').text('5. Security Protection');
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555');
      doc.text(`Risk Score: ${overview.protection.riskScore}/100`);
      doc.text(`Verdict: ${overview.protection.verdict}`);
      doc.moveDown(0.3);
      for (const [severity, count] of Object.entries(overview.protection.bySeverity)) {
        doc.fontSize(10).fillColor('#555').text(`  ${severity}: ${count} findings`);
      }
      doc.moveDown(1);

      // ── Section: DSAR ────────────────────────────────────────────
      doc.fontSize(16).fillColor('#333').text('6. DSAR Compliance');
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555');
      doc.text(`Total Requests: ${overview.dsar.totalRequests}`);
      doc.text(`Compliance Rate: ${overview.dsar.complianceRate}%`);
      doc.moveDown(1);

      // ── Section: Alerts ──────────────────────────────────────────
      if (alerts && alerts.length > 0) {
        doc.fontSize(16).fillColor('#333').text('7. Alert History');
        doc.moveDown(0.5);
        for (const alert of alerts.slice(0, 10)) {
          const color = alert.severity === 'critical' ? '#dc3545'
            : alert.severity === 'warning' ? '#ffc107' : '#17a2b8';
          doc.fontSize(10).fillColor(color).text(`[${alert.severity.toUpperCase()}] ${alert.title}`);
          doc.fontSize(9).fillColor('#666').text(`  ${alert.sentAt} | ${alert.type}`);
        }
        doc.moveDown(1);
      }

      // ── Footer ───────────────────────────────────────────────────
      doc.fontSize(8).fillColor('#999')
        .text('AutoTGC Governance Platform — Confidential', 50, doc.page.height - 40, { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
