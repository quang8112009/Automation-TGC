/**
 * retention — Data retention and purge policies.
 *
 * Enforces data lifecycle management: when data should be anonymized, archived,
 * or deleted based on its classification level and age. Supports GDPR Right to
 * Erasure (Article 17), CCPA, and Vietnamese PDPD data retention requirements.
 *
 * DESIGN:
 *   - Policy-driven: each classification level maps to a retention period.
 *   - Idempotent: running purge multiple times is safe (no double-delete).
 *   - Audit-logged: every purge/anonymization is logged for compliance.
 *   - Dry-run mode: preview what would be deleted without actually deleting.
 *
 * USAGE:
 *   import { RetentionPolicy, purgeExpiredData } from '../governance/retention';
 *
 *   const policy = new RetentionPolicy(prisma);
 *   const result = await policy.purge({ dryRun: true });
 *   console.log(`Would delete ${result.deleted} records, anonymize ${result.anonymized}.`);
 */
import type { PrismaClient } from '@prisma/client';
import { hashSha256 } from './encryption';
import type { RetentionPeriod } from './classification';
import { AuditLogger, type AuditAction } from './audit';

// ── Types ───────────────────────────────────────────────────────────────────

/** Retention policy configuration per table. */
export interface TableRetentionConfig {
  /** Database table name. */
  table: string;
  /** Column that contains the timestamp to check against. */
  timestampColumn: string;
  /** Default retention period. */
  defaultRetention: RetentionPeriod;
  /** Column to anonymize (instead of deleting). */
  anonymizeColumn?: string;
  /** Whether to hard-delete or soft-delete. */
  hardDelete: boolean;
  /** Whether this table contains PII (triggers extra audit logging). */
  containsPii: boolean;
}

/** Result of a purge operation. */
export interface PurgeResult {
  /** Number of records deleted. */
  deleted: number;
  /** Number of records anonymized. */
  anonymized: number;
  /** Per-table breakdown. */
  tables: Array<{
    table: string;
    deleted: number;
    anonymized: number;
    oldestRecord: string | null;
  }>;
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** ISO timestamp of when the purge ran. */
  executedAt: string;
}

/** Purge options. */
export interface PurgeOptions {
  /** Preview mode: don't actually delete, just report. */
  dryRun?: boolean;
  /** Only purge specific tables (default: all). */
  tables?: string[];
  /** Override retention periods per table. */
  overrides?: Partial<Record<string, RetentionPeriod>>;
}

// ── Retention Period → Days ─────────────────────────────────────────────────

/** Convert retention period to number of days. */
function retentionDays(period: RetentionPeriod): number {
  switch (period) {
    case 'session': return 0;
    case '30_days': return 30;
    case '90_days': return 90;
    case '6_months': return 180;
    case '12_months': return 365;
    case '24_months': return 730;
    case '36_months': return 1095;
    case 'indefinite': return Infinity;
    case 'legal_hold': return Infinity;
    default: return 365;
  }
}

// ── Default Table Configurations ────────────────────────────────────────────

/** Default retention configurations for known tables. */
const DEFAULT_TABLE_CONFIGS: ReadonlyArray<TableRetentionConfig> = [
  {
    table: 'AuditEntry',
    timestampColumn: 'createdAt',
    defaultRetention: '36_months',
    anonymizeColumn: 'detail',
    hardDelete: false,
    containsPii: true,
  },
  {
    table: 'ActivityLog',
    timestampColumn: 'createdAt',
    defaultRetention: '24_months',
    anonymizeColumn: 'detail',
    hardDelete: false,
    containsPii: true,
  },
  {
    table: 'Notification',
    timestampColumn: 'createdAt',
    defaultRetention: '12_months',
    hardDelete: true,
    containsPii: false,
  },
];

// ── Retention Policy Engine ─────────────────────────────────────────────────

/**
 * Data retention and purge policy engine.
 */
export class RetentionPolicy {
  private readonly configs: Map<string, TableRetentionConfig>;
  private readonly audit: AuditLogger;

  constructor(
    private readonly prisma: PrismaClient,
    configs?: TableRetentionConfig[],
  ) {
    this.configs = new Map(
      (configs ?? DEFAULT_TABLE_CONFIGS).map((c) => [c.table, c]),
    );
    this.audit = new AuditLogger(prisma);
  }

  /**
   * Register a custom table retention configuration.
   */
  registerTable(config: TableRetentionConfig): void {
    this.configs.set(config.table, config);
  }

  /**
   * Get the cutoff date for a retention period.
   */
  getCutoffDate(period: RetentionPeriod): Date | null {
    const days = retentionDays(period);
    if (!Number.isFinite(days)) return null;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return cutoff;
  }

  /**
   * Preview what would be purged (dry run).
   */
  async preview(options: PurgeOptions = {}): Promise<PurgeResult> {
    return this.executePurge({ ...options, dryRun: true });
  }

  /**
   * Execute the purge operation.
   */
  async purge(options: PurgeOptions = {}): Promise<PurgeResult> {
    return this.executePurge({ ...options, dryRun: options.dryRun ?? false });
  }

  /**
   * Anonymize a specific record (GDPR Right to Erasure).
   */
  async anonymizeRecord(
    table: string,
    recordId: string,
    reason: string = 'GDPR erasure request',
  ): Promise<void> {
    const config = this.configs.get(table);
    if (!config) {
      throw new Error(`No retention config for table: ${table}`);
    }

    const anonymizedValue = `[ANONYMIZED_${hashSha256(recordId).slice(0, 8)}]`;

    if (config.anonymizeColumn) {
      // Update the specific column.
      const tableClient = (this.prisma as unknown as Record<string, unknown>)[table] as { update: (args: unknown) => Promise<unknown> };
      await tableClient.update({
        where: { id: recordId },
        data: { [config.anonymizeColumn]: anonymizedValue },
      });
    }

    await this.audit.log({
      action: 'PII_ERASURE',
      actor: { id: 'system' },
      resource: { type: table.toLowerCase(), id: recordId },
      detail: { reason, anonymizedColumn: config.anonymizeColumn },
    });
  }

  /**
   * Get retention status for all configured tables.
   */
  async getStatus(): Promise<Array<{
    table: string;
    config: TableRetentionConfig;
    cutoff: Date | null;
    recordCount: number;
    expiredCount: number;
  }>> {
    const statuses: Array<{
      table: string;
      config: TableRetentionConfig;
      cutoff: Date | null;
      recordCount: number;
      expiredCount: number;
    }> = [];

    for (const [table, config] of this.configs) {
      const cutoff = this.getCutoffDate(config.defaultRetention);

      let recordCount = 0;
      let expiredCount = 0;

      try {
        const tableClient = this.getTable(table);
        recordCount = await (tableClient.count as (args: unknown) => Promise<number>)({}) ?? 0;

        if (cutoff) {
          expiredCount = await (tableClient.count as (args: unknown) => Promise<number>)({
            where: { [config.timestampColumn]: { lt: cutoff } },
          }) ?? 0;
        }
      } catch {
        // Table might not exist yet.
      }

      statuses.push({ table, config, cutoff, recordCount, expiredCount });
    }

    return statuses;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Get a dynamic table client from Prisma (for runtime table access). */
  private getTable(table: string): Record<string, unknown> {
    return (this.prisma as unknown as Record<string, unknown>)[table] as Record<string, unknown>;
  }

  private async executePurge(options: PurgeOptions): Promise<PurgeResult> {
    const dryRun = options.dryRun ?? false;
    const result: PurgeResult = {
      deleted: 0,
      anonymized: 0,
      tables: [],
      dryRun,
      executedAt: new Date().toISOString(),
    };

    for (const [table, config] of this.configs) {
      if (options.tables && !options.tables.includes(table)) continue;

      const retention = options.overrides?.[table] ?? config.defaultRetention;
      const cutoff = this.getCutoffDate(retention);

      // Skip indefinite/legal_hold tables.
      if (!cutoff) {
        result.tables.push({ table, deleted: 0, anonymized: 0, oldestRecord: null });
        continue;
      }

      let deleted = 0;
      let anonymized = 0;
      let oldestRecord: string | null = null;

      try {
        // Count expired records.
        const purgeTable = this.getTable(table);
        const expiredCount = await (purgeTable.count as (args: unknown) => Promise<number>)({
          where: { [config.timestampColumn]: { lt: cutoff } },
        }) ?? 0;

        if (expiredCount === 0) {
          result.tables.push({ table, deleted: 0, anonymized: 0, oldestRecord: null });
          continue;
        }

        // Find oldest record for reporting.
        const oldest = await (purgeTable.findFirst as (args: unknown) => Promise<Record<string, unknown> | null>)({
          where: { [config.timestampColumn]: { lt: cutoff } },
          orderBy: { [config.timestampColumn]: 'asc' },
          select: { [config.timestampColumn]: true },
        });
        oldestRecord = (oldest?.[config.timestampColumn] as Date | undefined)?.toISOString() ?? null;

        if (!dryRun) {
          if (config.hardDelete) {
            // Hard delete expired records.
            const deletedResult = await (purgeTable.deleteMany as (args: unknown) => Promise<{ count: number }>)({
              where: { [config.timestampColumn]: { lt: cutoff } },
            });
            deleted = deletedResult?.count ?? 0;
          } else if (config.anonymizeColumn) {
            // Anonymize instead of delete.
            const updated = await (purgeTable.updateMany as (args: unknown) => Promise<{ count: number }>)({
              where: { [config.timestampColumn]: { lt: cutoff } },
              data: { [config.anonymizeColumn]: '[ANONYMIZED]' },
            });
            anonymized = updated?.count ?? 0;
          }

          // Audit log the purge.
          await this.audit.log({
            action: 'RETENTION_APPLIED',
            actor: { id: 'system' },
            resource: { type: table.toLowerCase(), id: 'batch' },
            detail: {
              table,
              deleted,
              anonymized,
              cutoff: cutoff.toISOString(),
              retention,
            },
          });
        } else {
          deleted = config.hardDelete ? expiredCount : 0;
          anonymized = config.anonymizeColumn ? expiredCount : 0;
        }
      } catch {
        // Table might not exist or have the expected columns.
      }

      result.deleted += deleted;
      result.anonymized += anonymized;
      result.tables.push({ table, deleted, anonymized, oldestRecord });
    }

    return result;
  }
}
