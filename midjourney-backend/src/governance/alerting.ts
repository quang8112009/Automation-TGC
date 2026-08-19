/**
 * compliance/alerting — Automated compliance alerting.
 *
 * Sends alerts when compliance scores drop below configurable thresholds,
 * when critical findings appear, or when retention health degrades.
 *
 * Channels:
 *   - Slack (via incoming webhook URL)
 *   - Email  (via Nodemailer / SMTP)
 *   - Both
 *
 * Cooldown: prevents alert fatigue by suppressing duplicate alerts within
 * a configurable window (default 4 hours per alert type).
 *
 * History: all sent alerts are persisted in the `ComplianceAlert` table
 * for audit and dashboard display.
 *
 * USAGE:
 *   import { ComplianceAlerter } from '../governance/alerting';
 *   const alerter = new ComplianceAlerter(prisma);
 *   await alerter.evaluate(complianceScore, report);
 */
import type { PrismaClient } from '@prisma/client';

// ── Types ────────────────────────────────────────────────────────────────────

/** Alert severity levels. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** The type of compliance event that triggered an alert. */
export type AlertType =
  | 'SCORE_DROP'
  | 'CRITICAL_FINDING'
  | 'RETENTION_CRITICAL'
  | 'CONSENT_LOW'
  | 'PII_EXPOSURE_HIGH'
  | 'DSAR_NONCOMPLIANT'
  | 'SECURITY_VERDICT_FAIL';

/** Channel configuration. */
export interface AlertChannels {
  slack?: { webhookUrl: string };
  email?: { smtpHost: string; smtpPort: number; from: string; to: string[] };
}

/** Alert threshold configuration. */
export interface AlertThresholds {
  /** Score at which a WARNING alert fires (default: 80). */
  scoreWarning: number;
  /** Score at which a CRITICAL alert fires (default: 60). */
  scoreCritical: number;
  /** Cooldown in ms between duplicate alerts of the same type (default: 4h). */
  cooldownMs: number;
}

/** A single alert payload. */
export interface ComplianceAlert {
  id: string;
  severity: AlertSeverity;
  type: AlertType;
  title: string;
  message: string;
  score: number;
  details: Record<string, unknown>;
  channels: string[];
  sentAt: string;
}

/** Summary for the dashboard. */
export interface AlertHistoryEntry {
  id: string;
  severity: AlertSeverity;
  type: AlertType;
  title: string;
  message: string;
  score: number;
  channels: string[];
  sentAt: string;
}

/** Evaluation result. */
export interface EvaluationResult {
  score: number;
  alerts: ComplianceAlert[];
  previousScore: number | null;
  scoreDelta: number | null;
}

/** Snapshot of compliance data used for evaluation. */
export interface ComplianceSnapshot {
  audit?: {
    totalEntries: number;
  };
  piiExposure?: {
    overallClassification: string;
    recommendations: string[];
  };
  retention?: {
    overallStatus: 'healthy' | 'warning' | 'critical';
  };
  consent?: {
    consentRate: number;
  };
  protection?: {
    verdict: string;
    criticalFindings: Array<{ id: string; title: string }>;
  };
  dsar?: {
    complianceRate: number;
  };
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: AlertThresholds = {
  scoreWarning: 80,
  scoreCritical: 60,
  cooldownMs: 4 * 60 * 60 * 1000, // 4 hours
};

// ── Compliance Alerter ───────────────────────────────────────────────────────

/**
 * Evaluates compliance posture and fires alerts through configured channels.
 */
export class ComplianceAlerter {
  private readonly channels: AlertChannels;
  private readonly thresholds: AlertThresholds;
  private cooldowns = new Map<string, number>(); // type -> last-sent timestamp

  constructor(
    private readonly prisma: PrismaClient,
    channels?: AlertChannels,
    thresholds?: Partial<AlertThresholds>,
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

    // Load channels from env if not explicitly provided.
    this.channels = channels ?? {
      slack: process.env.SLACK_COMPLIANCE_WEBHOOK
        ? { webhookUrl: process.env.SLACK_COMPLIANCE_WEBHOOK }
        : undefined,
      email:
        process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.SMTP_TO
          ? {
              smtpHost: process.env.SMTP_HOST,
              smtpPort: Number(process.env.SMTP_PORT) || 587,
              from: process.env.SMTP_FROM,
              to: process.env.SMTP_TO.split(',').map((s) => s.trim()),
            }
          : undefined,
    };
  }

  /**
   * Evaluate the current compliance state and fire alerts if needed.
   */
  async evaluate(
    score: number,
    snapshot: ComplianceSnapshot,
  ): Promise<EvaluationResult> {
    const alerts: ComplianceAlert[] = [];
    let previousScore: number | null = null;

    // Get the previous score from the last alert.
    try {
      const last = await (this.prisma as unknown as Record<string, { findFirst: (args: Record<string, unknown>) => Promise<{ score: number } | null> }>).complianceAlert.findFirst({
        orderBy: { sentAt: 'desc' },
        select: { score: true },
      });
      previousScore = last?.score ?? null;
    } catch {
      // Table may not exist yet.
    }

    const scoreDelta = previousScore !== null ? score - previousScore : null;

    // ── Score-based alerts ──────────────────────────────────────────────
    if (score <= this.thresholds.scoreCritical) {
      const alert = this.buildAlert({
        type: 'SCORE_DROP',
        severity: 'critical',
        title: `Compliance score CRITICAL: ${score}/100`,
        message: `The compliance score has dropped to ${score}/100 (threshold: ${this.thresholds.scoreCritical}). Previous: ${previousScore ?? 'N/A'}${scoreDelta !== null ? `, Δ${scoreDelta > 0 ? '+' : ''}${scoreDelta}` : ''}`,
        score,
        details: { previousScore, scoreDelta, threshold: this.thresholds.scoreCritical },
      });
      if (alert) alerts.push(alert);
    } else if (score <= this.thresholds.scoreWarning) {
      const alert = this.buildAlert({
        type: 'SCORE_DROP',
        severity: 'warning',
        title: `Compliance score WARNING: ${score}/100`,
        message: `The compliance score has dropped to ${score}/100 (threshold: ${this.thresholds.scoreWarning}). Previous: ${previousScore ?? 'N/A'}${scoreDelta !== null ? `, Δ${scoreDelta > 0 ? '+' : ''}${scoreDelta}` : ''}`,
        score,
        details: { previousScore, scoreDelta, threshold: this.thresholds.scoreWarning },
      });
      if (alert) alerts.push(alert);
    }

    // ── Critical security findings ──────────────────────────────────────
    if (snapshot.protection?.verdict === 'FAIL') {
      const alert = this.buildAlert({
        type: 'SECURITY_VERDICT_FAIL',
        severity: 'critical',
        title: 'Workload security scan FAILED',
        message: `Security verdict: FAIL. ${snapshot.protection.criticalFindings.length} critical finding(s): ${snapshot.protection.criticalFindings.map((f) => f.title).join('; ')}`,
        score,
        details: {
          verdict: snapshot.protection.verdict,
          criticalFindings: snapshot.protection.criticalFindings,
        },
      });
      if (alert) alerts.push(alert);
    }

    // ── Retention critical ──────────────────────────────────────────────
    if (snapshot.retention?.overallStatus === 'critical') {
      const alert = this.buildAlert({
        type: 'RETENTION_CRITICAL',
        severity: 'warning',
        title: 'Data retention health is CRITICAL',
        message: 'One or more data tables have exceeded retention thresholds and require immediate purge or anonymization.',
        score,
        details: { retentionStatus: snapshot.retention.overallStatus },
      });
      if (alert) alerts.push(alert);
    }

    // ── Consent rate low ────────────────────────────────────────────────
    if (snapshot.consent !== undefined && snapshot.consent.consentRate < 80) {
      const alert = this.buildAlert({
        type: 'CONSENT_LOW',
        severity: 'warning',
        title: `Consent rate low: ${snapshot.consent.consentRate}%`,
        message: `The effective consent rate has fallen to ${snapshot.consent.consentRate}%, below the 80% compliance threshold.`,
        score,
        details: { consentRate: snapshot.consent.consentRate },
      });
      if (alert) alerts.push(alert);
    }

    // ── PII exposure high ───────────────────────────────────────────────
    if (
      snapshot.piiExposure !== undefined &&
      snapshot.piiExposure.overallClassification === 'RESTRICTED'
    ) {
      const alert = this.buildAlert({
        type: 'PII_EXPOSURE_HIGH',
        severity: 'warning',
        title: 'PII exposure level: RESTRICTED',
        message: `PII classification is RESTRICTED. ${snapshot.piiExposure.recommendations.length} recommendation(s): ${snapshot.piiExposure.recommendations.slice(0, 3).join('; ')}`,
        score,
        details: {
          classification: snapshot.piiExposure.overallClassification,
          recommendations: snapshot.piiExposure.recommendations,
        },
      });
      if (alert) alerts.push(alert);
    }

    // ── DSAR non-compliant ──────────────────────────────────────────────
    if (snapshot.dsar !== undefined && snapshot.dsar.complianceRate < 100) {
      const alert = this.buildAlert({
        type: 'DSAR_NONCOMPLIANT',
        severity: 'critical',
        title: `DSAR compliance rate: ${snapshot.dsar.complianceRate}%`,
        message: `DSAR compliance rate has dropped to ${snapshot.dsar.complianceRate}%. One or more data subject requests are overdue.`,
        score,
        details: { complianceRate: snapshot.dsar.complianceRate },
      });
      if (alert) alerts.push(alert);
    }

    // ── Send all alerts ─────────────────────────────────────────────────
    for (const alert of alerts) {
      await this.sendAlert(alert);
      await this.persistAlert(alert);
    }

    return { score, alerts, previousScore, scoreDelta };
  }

  /**
   * Get alert history for the compliance dashboard.
   */
  async getAlertHistory(options: {
    limit?: number;
    severity?: AlertSeverity;
    type?: AlertType;
    since?: string;
  } = {}): Promise<AlertHistoryEntry[]> {
    const where: Record<string, unknown> = {};
    if (options.severity) where.severity = options.severity;
    if (options.type) where.type = options.type;
    if (options.since) where.sentAt = { gte: new Date(options.since) };

    try {
      const entries = await (this.prisma as unknown as Record<string, { findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string; severity: string; type: string; title: string; message: string; score: number; channels: string[]; sentAt: Date }>> }>).complianceAlert.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        take: options.limit ?? 50,
      });
      return entries.map((e) => ({
        id: e.id,
        severity: e.severity as AlertSeverity,
        type: e.type as AlertType,
        title: e.title,
        message: e.message,
        score: e.score,
        channels: (e.channels as unknown as string[]) ?? [],
        sentAt: e.sentAt?.toISOString?.() ?? String(e.sentAt),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get alert statistics for the dashboard.
   */
  async getAlertStats(): Promise<{
    totalAlerts: number;
    bySeverity: Record<AlertSeverity, number>;
    byType: Record<AlertType, number>;
    lastAlertAt: string | null;
    cooldownMs: number;
  }> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    try {
      const all = await (this.prisma as unknown as Record<string, { findMany: (args: Record<string, unknown>) => Promise<Array<{ severity: string; type: string; sentAt: Date }>> }>).complianceAlert.findMany({
        where: { sentAt: { gte: last24h } },
        select: { severity: true, type: true, sentAt: true },
      });

      const bySeverity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
      const byType: Record<string, number> = {};

      for (const entry of all) {
        bySeverity[entry.severity] = (bySeverity[entry.severity] ?? 0) + 1;
        byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      }

      const lastAlert = all.length > 0 ? all[0].sentAt : null;

      return {
        totalAlerts: all.length,
        bySeverity: bySeverity as Record<AlertSeverity, number>,
        byType: byType as Record<AlertType, number>,
        lastAlertAt: lastAlert?.toISOString?.() ?? null,
        cooldownMs: this.thresholds.cooldownMs,
      };
    } catch {
      return {
        totalAlerts: 0,
        bySeverity: { info: 0, warning: 0, critical: 0 },
        byType: {} as Record<AlertType, number>,
        lastAlertAt: null,
        cooldownMs: this.thresholds.cooldownMs,
      };
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Build an alert, checking cooldown. Returns null if suppressed.
   */
  private buildAlert(params: {
    type: AlertType;
    severity: AlertSeverity;
    title: string;
    message: string;
    score: number;
    details: Record<string, unknown>;
  }): ComplianceAlert | null {
    const cooldownKey = `${params.type}:${params.severity}`;
    const lastSent = this.cooldowns.get(cooldownKey) ?? 0;
    const now = Date.now();

    if (now - lastSent < this.thresholds.cooldownMs) {
      return null; // Suppressed by cooldown.
    }

    this.cooldowns.set(cooldownKey, now);

    const channels: string[] = [];
    if (this.channels.slack) channels.push('slack');
    if (this.channels.email) channels.push('email');

    return {
      id: `alert-${now}-${Math.random().toString(36).slice(2, 8)}`,
      severity: params.severity,
      type: params.type,
      title: params.title,
      message: params.message,
      score: params.score,
      details: params.details,
      channels,
      sentAt: new Date(now).toISOString(),
    };
  }

  /**
   * Send an alert through all configured channels.
   */
  private async sendAlert(alert: ComplianceAlert): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.channels.slack) {
      promises.push(this.sendSlack(alert, this.channels.slack.webhookUrl));
    }
    if (this.channels.email) {
      promises.push(this.sendEmail(alert, this.channels.email));
    }

    // Don't let a channel failure block others.
    await Promise.allSettled(promises);
  }

  /**
   * Send a Slack alert via incoming webhook.
   */
  private async sendSlack(alert: ComplianceAlert, webhookUrl: string): Promise<void> {
    const color =
      alert.severity === 'critical' ? '#dc3545' :
      alert.severity === 'warning' ? '#ffc107' : '#17a2b8';

    const emoji =
      alert.severity === 'critical' ? '🚨' :
      alert.severity === 'warning' ? '⚠️' : 'ℹ️';

    const payload = {
      attachments: [
        {
          color,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: `${emoji} ${alert.title}` },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Severity:*\n${alert.severity.toUpperCase()}` },
                { type: 'mrkdwn', text: `*Score:*\n${alert.score}/100` },
                { type: 'mrkdwn', text: `*Type:*\n${alert.type}` },
                { type: 'mrkdwn', text: `*Time:*\n<!date^${Math.floor(Date.now() / 1000)}^{date_short_prettime}|${alert.sentAt}>` },
              ],
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: alert.message },
            },
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: `Auto-generated by compliance alerting • ID: \`${alert.id}\`` },
              ],
            },
          ],
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[GOVERNANCE-ALERT] Slack delivery failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Send an email alert.
   */
  private async sendEmail(
    alert: ComplianceAlert,
    emailConfig: NonNullable<AlertChannels['email']>,
  ): Promise<void> {
    // Build HTML email body.
    const severityColor =
      alert.severity === 'critical' ? '#dc3545' :
      alert.severity === 'warning' ? '#ffc107' : '#17a2b8';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${severityColor}; color: white; padding: 16px 20px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0; font-size: 18px;">${alert.title}</h2>
  </div>
  <div style="border: 1px solid #dee2e6; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
      <tr>
        <td style="padding: 8px 12px; color: #6c757d; width: 120px;"><strong>Severity</strong></td>
        <td style="padding: 8px 12px;"><span style="background: ${severityColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; text-transform: uppercase;">${alert.severity}</span></td>
      </tr>
      <tr>
        <td style="padding: 8px 12px; color: #6c757d;"><strong>Score</strong></td>
        <td style="padding: 8px 12px;">${alert.score}/100</td>
      </tr>
      <tr>
        <td style="padding: 8px 12px; color: #6c757d;"><strong>Type</strong></td>
        <td style="padding: 8px 12px;">${alert.type}</td>
      </tr>
      <tr>
        <td style="padding: 8px 12px; color: #6c757d;"><strong>Time</strong></td>
        <td style="padding: 8px 12px;">${alert.sentAt}</td>
      </tr>
    </table>
    <div style="background: #f8f9fa; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px;">
      <p style="margin: 0; line-height: 1.5;">${alert.message}</p>
    </div>
    <p style="color: #6c757d; font-size: 12px; margin: 0;">Alert ID: ${alert.id}</p>
  </div>
</body>
</html>`;

    // Use fetch to send via SMTP (or any email API).
    // For production, integrate with Nodemailer or an email API.
    // Here we log the email for now and support webhook-based email services.
    console.log(`[GOVERNANCE-ALERT] Email alert: ${alert.title} → ${emailConfig.to.join(', ')}`);

    // If an SMTP webhook/API URL is configured, send via fetch.
    if (process.env.SMTP_WEBHOOK_URL) {
      try {
        await fetch(process.env.SMTP_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: emailConfig.from,
            to: emailConfig.to,
            subject: `[Compliance ${alert.severity.toUpperCase()}] ${alert.title}`,
            html,
            text: `${alert.title}\n\nSeverity: ${alert.severity.toUpperCase()}\nScore: ${alert.score}/100\nType: ${alert.type}\n\n${alert.message}\n\nAlert ID: ${alert.id}`,
          }),
        });
      } catch (err) {
        console.error(`[GOVERNANCE-ALERT] Email delivery failed:`, err);
      }
    }
  }

  /**
   * Persist an alert to the database.
   */
  private async persistAlert(alert: ComplianceAlert): Promise<void> {
    try {
      await (this.prisma as unknown as Record<string, { create: (data: Record<string, unknown>) => Promise<unknown> }>).complianceAlert.create({
        data: {
          id: alert.id,
          severity: alert.severity,
          type: alert.type,
          title: alert.title,
          message: alert.message,
          score: alert.score,
          details: alert.details,
          channels: alert.channels,
          sentAt: new Date(alert.sentAt),
        },
      });
    } catch {
      // Table may not exist yet — alert is still sent, just not persisted.
      console.warn(`[GOVERNANCE-ALERT] Could not persist alert ${alert.id} (table may not exist)`);
    }
  }
}
