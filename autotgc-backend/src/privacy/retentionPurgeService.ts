/**
 * RetentionPurgeService — ENFORCES the retention schedule (security/privacy).
 *
 * `analytics/retention.ts` defines the pure cutoff predicate but nothing ever
 * deleted aged data, so analytics + PII accumulated forever. This service runs
 * on a cadence and:
 *  - deletes Analytics_Record / Performance_Record older than the analytics
 *    Retention_Period (default 12 months);
 *  - anonymizes (does NOT delete) the PII columns of Lead / IntakeConversation /
 *    IntakeMessage older than the PII Retention_Period (default 24 months) while
 *    keeping non-identifying rows for aggregate reporting;
 *  - redacts the `detail` payload of AuditEntry / ActivityLog older than the log
 *    Retention_Period (default 24 months) so append-only logs stop storing PII
 *    forever (the immutable ledger row itself is preserved).
 *
 * All windows are configurable (months). The purge is idempotent: re-running it
 * over already-purged rows is a cheap no-op. It returns counts only — never PII.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { retentionCutoff, DEFAULT_RETENTION_MONTHS } from '../analytics/retention';

/** Placeholder written into required identifying columns during anonymization. */
const ERASED = '[EXPIRED]';
const REDACTED_DETAIL = { redacted: true } as const;

export interface RetentionConfig {
  /** Months to keep raw analytics + performance records (default 12). */
  analyticsMonths: number;
  /** Months to keep identifiable lead/intake PII before anonymizing (default 24). */
  piiMonths: number;
  /** Months to keep audit/activity log detail payloads before redacting (default 24). */
  logMonths: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  analyticsMonths: DEFAULT_RETENTION_MONTHS, // 12
  piiMonths: 24,
  logMonths: 24,
};

export interface PurgeSummary {
  analyticsRecords: number;
  performanceRecords: number;
  leadsAnonymized: number;
  intakeConversationsAnonymized: number;
  intakeMessagesRedacted: number;
  auditEntriesRedacted: number;
  activityLogsRedacted: number;
}

export class RetentionPurgeService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: RetentionConfig = DEFAULT_RETENTION_CONFIG,
  ) {}

  /** Run the full purge using `now` as the reference clock (injectable for tests). */
  async purge(now: Date = new Date()): Promise<PurgeSummary> {
    const analyticsCutoff = retentionCutoff(now, this.config.analyticsMonths);
    const piiCutoff = retentionCutoff(now, this.config.piiMonths);
    const logCutoff = retentionCutoff(now, this.config.logMonths);

    // --- Raw analytics: hard-delete beyond the analytics window --------------
    const analyticsRecords = await this.prisma.analyticsRecord.deleteMany({
      where: { collectedAt: { lt: analyticsCutoff } },
    });
    const performanceRecords = await this.prisma.performanceRecord.deleteMany({
      where: { scoredAt: { lt: analyticsCutoff } },
    });

    // --- Lead PII: anonymize beyond the PII window (keep the row) ------------
    // Only touch rows that still carry identifying data (idempotent).
    const leadsAnonymized = await this.prisma.lead.updateMany({
      where: {
        createdAt: { lt: piiCutoff },
        OR: [{ name: { not: null } }, { phone: { not: null } }, { email: { not: null } }],
      },
      data: { name: null, phone: null, email: null, note: null },
    });

    // --- Intake conversation + message PII: anonymize beyond the PII window --
    const intakeConversationsAnonymized = await this.prisma.intakeConversation.updateMany({
      where: { createdAt: { lt: piiCutoff }, displayName: { not: null } },
      data: { displayName: null, collected: {} },
    });
    const intakeMessagesRedacted = await this.prisma.intakeMessage.updateMany({
      where: { createdAt: { lt: piiCutoff }, NOT: { text: ERASED } },
      data: { text: ERASED, raw: Prisma.DbNull },
    });

    // --- Append-only logs: redact stale detail payloads (keep the ledger) ----
    const auditEntriesRedacted = await this.prisma.auditEntry.updateMany({
      where: { recordedAt: { lt: logCutoff } },
      data: { detail: REDACTED_DETAIL },
    });
    const activityLogsRedacted = await this.prisma.activityLog.updateMany({
      where: { createdAt: { lt: logCutoff } },
      data: { detail: REDACTED_DETAIL },
    });

    return {
      analyticsRecords: analyticsRecords.count,
      performanceRecords: performanceRecords.count,
      leadsAnonymized: leadsAnonymized.count,
      intakeConversationsAnonymized: intakeConversationsAnonymized.count,
      intakeMessagesRedacted: intakeMessagesRedacted.count,
      auditEntriesRedacted: auditEntriesRedacted.count,
      activityLogsRedacted: activityLogsRedacted.count,
    };
  }
}

/** PURE: parse a positive-integer months env, falling back to `fallback`. */
export function parseRetentionMonths(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}
