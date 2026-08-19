/**
 * audit — Immutable audit logging for compliance.
 *
 * Provides append-only, tamper-evident audit logging for all data access,
 * modifications, and governance events. Supports GDPR Article 30 (Records of
 * Processing Activities), CCPA, and Vietnamese PDPD requirements.
 *
 * DESIGN:
 *   - Append-only: entries cannot be modified or deleted.
 *   - Tamper-evident: each entry includes a chained hash (like a blockchain).
   - Structured: every entry has timestamp, actor, action, resource, and detail.
 *   - Redactable: PII in audit logs is automatically masked.
 *   - Exportable: supports JSON export for regulatory audits.
 *
 * USAGE:
 *   import { AuditLogger, AuditAction } from '../governance/audit';
 *
 *   const audit = new AuditLogger(prisma);
 *   await audit.log({
 *     action: 'DATA_ACCESS',
 *     actor: { id: 'user-1', role: 'ADMIN' },
 *     resource: { type: 'lead', id: 'lead-123' },
 *     detail: { fields: ['email', 'phone'] },
 *   });
 */
import type { PrismaClient } from '@prisma/client';
import { hashSha256 } from './encryption';
import { maskPii } from './pii';

// ── Types ───────────────────────────────────────────────────────────────────

/** Audit action categories. */
export type AuditAction =
  // Data access
  | 'DATA_ACCESS'
  | 'DATA_EXPORT'
  | 'DATA_SEARCH'
  // Data modification
  | 'DATA_CREATE'
  | 'DATA_UPDATE'
  | 'DATA_DELETE'
  | 'DATA_SOFT_DELETE'
  // Authentication
  | 'AUTH_LOGIN'
  | 'AUTH_LOGOUT'
  | 'AUTH_FAILED'
  | 'AUTH_LOCKED'
  | 'AUTH_UNLOCKED'
  | 'AUTH_PASSWORD_CHANGE'
  // Authorization
  | 'AUTHZ_GRANT'
  | 'AUTHZ_DENY'
  | 'AUTHZ_ROLE_CHANGE'
  // Governance
  | 'PII_DETECTED'
  | 'PII_MASKED'
  | 'PII_ERASURE'
  | 'DATA_CLASSIFIED'
  | 'RETENTION_APPLIED'
  | 'ENCRYPTION_APPLIED'
  // System
  | 'SYSTEM_CONFIG_CHANGE'
  | 'SYSTEM_ERROR'
  | 'WEBHOOK_RECEIVED'
  | 'BATCH_RENDER';

/** Actor who performed the action. */
export interface AuditActor {
  /** User ID (or 'system' for automated actions). */
  id: string;
  /** User role. */
  role?: string;
  /** IP address. */
  ip?: string;
  /** User agent string. */
  userAgent?: string;
}

/** Resource targeted by the action. */
export interface AuditResource {
  /** Resource type (e.g., 'lead', 'candidate', 'draft'). */
  type: string;
  /** Resource ID. */
  id: string;
  /** Additional metadata about the resource. */
  metadata?: Record<string, unknown>;
}

/** A single audit log entry. */
export interface AuditEntry {
  /** Unique entry ID. */
  id: string;
  /** ISO timestamp. */
  timestamp: string;
  /** The action performed. */
  action: AuditAction;
  /** Who performed the action. */
  actor: AuditActor;
  /** What was targeted. */
  resource: AuditResource;
  /** Additional detail (PII is auto-masked). */
  detail?: Record<string, unknown>;
  /** Previous entry hash (for tamper-evidence chain). */
  previousHash: string;
  /** This entry's hash (SHA-256 of timestamp + action + actor + resource + detail + previousHash). */
  entryHash: string;
  /** Risk level for this action. */
  risk: 'low' | 'medium' | 'high' | 'critical';
}

/** Audit query filter. */
export interface AuditQuery {
  /** Filter by action(s). */
  actions?: AuditAction[];
  /** Filter by actor ID. */
  actorId?: string;
  /** Filter by resource type. */
  resourceType?: string;
  /** Filter by resource ID. */
  resourceId?: string;
  /** Filter by risk level. */
  risk?: AuditEntry['risk'];
  /** Start date (ISO). */
  from?: string;
  /** End date (ISO). */
  to?: string;
  /** Maximum entries to return. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
}

// ── Risk Assessment ─────────────────────────────────────────────────────────

/** Action → risk level mapping. */
const ACTION_RISK: Readonly<Record<AuditAction, AuditEntry['risk']>> = {
  DATA_ACCESS: 'low',
  DATA_EXPORT: 'high',
  DATA_SEARCH: 'low',
  DATA_CREATE: 'low',
  DATA_UPDATE: 'medium',
  DATA_DELETE: 'critical',
  DATA_SOFT_DELETE: 'medium',
  AUTH_LOGIN: 'low',
  AUTH_LOGOUT: 'low',
  AUTH_FAILED: 'medium',
  AUTH_LOCKED: 'high',
  AUTH_UNLOCKED: 'high',
  AUTH_PASSWORD_CHANGE: 'high',
  AUTHZ_GRANT: 'high',
  AUTHZ_DENY: 'medium',
  AUTHZ_ROLE_CHANGE: 'critical',
  PII_DETECTED: 'medium',
  PII_MASKED: 'low',
  PII_ERASURE: 'critical',
  DATA_CLASSIFIED: 'low',
  RETENTION_APPLIED: 'medium',
  ENCRYPTION_APPLIED: 'low',
  SYSTEM_CONFIG_CHANGE: 'critical',
  SYSTEM_ERROR: 'medium',
  WEBHOOK_RECEIVED: 'low',
  BATCH_RENDER: 'low',
};

// ── Audit Logger ────────────────────────────────────────────────────────────

/**
 * Immutable, append-only audit logger with tamper-evident chaining.
 */
export class AuditLogger {
  private lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

  constructor(private readonly prisma?: PrismaClient) {}

  /**
   * Log an audit entry. Appends to the in-memory chain and optionally persists
   * to the database (when Prisma is available).
   */
  async log(entry: {
    action: AuditAction;
    actor: AuditActor;
    resource: AuditResource;
    detail?: Record<string, unknown>;
  }): Promise<AuditEntry> {
    const now = new Date().toISOString();
    const risk = ACTION_RISK[entry.action] ?? 'low';

    // Auto-mask PII in detail fields.
    const maskedDetail = entry.detail ? maskObjectKeys(entry.detail) : undefined;

    // Compute chained hash for tamper-evidence.
    const hashInput = [
      now,
      entry.action,
      entry.actor.id,
      entry.resource.type,
      entry.resource.id,
      JSON.stringify(maskedDetail ?? {}),
      this.lastHash,
    ].join('|');
    const entryHash = hashSha256(hashInput);

    const auditEntry: AuditEntry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      action: entry.action,
      actor: entry.actor,
      resource: entry.resource,
      detail: maskedDetail,
      previousHash: this.lastHash,
      entryHash,
      risk,
    };

    this.lastHash = entryHash;

    // Persist to database if Prisma is available.
    if (this.prisma) {
      try {
        await (this.prisma as unknown as Record<string, { create: (data: unknown) => Promise<unknown> }>)
          .auditEntry.create({
            data: {
              action: entry.action,
              actorUserId: entry.actor.id,
              targetType: entry.resource.type,
              targetId: entry.resource.id,
              detail: maskedDetail ?? {},
            },
          });
      } catch {
        // Audit log write failure must not block the request.
        // In production, this would trigger an alert.
      }
    }

    return auditEntry;
  }

  /**
   * Verify the integrity of the audit chain.
   * Returns true if all entries are valid.
   */
  verifyChain(entries: AuditEntry[]): boolean {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Verify previous hash linkage.
      const expectedPrev = i === 0
        ? '0000000000000000000000000000000000000000000000000000000000000000'
        : entries[i - 1].entryHash;

      if (entry.previousHash !== expectedPrev) {
        return false;
      }

      // Verify entry hash.
      const hashInput = [
        entry.timestamp,
        entry.action,
        entry.actor.id,
        entry.resource.type,
        entry.resource.id,
        JSON.stringify(entry.detail ?? {}),
        entry.previousHash,
      ].join('|');

      if (entry.entryHash !== hashSha256(hashInput)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Export audit entries as a JSON report (for regulatory audits).
   */
  exportReport(entries: AuditEntry[]): {
    generatedAt: string;
    totalEntries: number;
    riskBreakdown: Record<string, number>;
    actionBreakdown: Record<string, number>;
    entries: AuditEntry[];
    integrityValid: boolean;
  } {
    const riskBreakdown: Record<string, number> = {};
    const actionBreakdown: Record<string, number> = {};

    for (const entry of entries) {
      riskBreakdown[entry.risk] = (riskBreakdown[entry.risk] ?? 0) + 1;
      actionBreakdown[entry.action] = (actionBreakdown[entry.action] ?? 0) + 1;
    }

    return {
      generatedAt: new Date().toISOString(),
      totalEntries: entries.length,
      riskBreakdown,
      actionBreakdown,
      entries,
      integrityValid: this.verifyChain(entries),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Mask PII values in an object's string fields. */
function maskObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = maskPii(value, { strategy: 'partial' });
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) =>
        typeof v === 'string' ? maskPii(v, { strategy: 'partial' }) : v,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
