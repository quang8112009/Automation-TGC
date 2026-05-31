/**
 * Audit_Log — append-only ledger (design Req 20).
 *
 * Exposes ONLY `append` plus read helpers; there is no update or delete path,
 * enforcing the append-only contract at the API layer (Req 20.4). Every insight
 * generated, every approve/reject decision, every conflict resolution, and every
 * applied strategy change is recorded here.
 */
import type { PrismaClient } from '@prisma/client';
import type { AuditEventType } from './types';

export interface AuditEntryView {
  id: string;
  eventType: AuditEventType;
  insightId: string;
  actor: string;
  detail: Record<string, unknown>;
  recordedAt: Date;
}

export class AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The only writer. Records a new audit entry; the server stamps `recordedAt`.
   * `detail` is stored verbatim as a Prisma Json column.
   */
  async append(
    eventType: AuditEventType,
    insightId: string,
    actor: string,
    detail: Record<string, unknown>,
  ): Promise<AuditEntryView> {
    const row = await this.prisma.auditEntry.create({
      data: {
        eventType,
        insightId,
        actor,
        detail: detail as object,
      },
    });
    return this.toView(row);
  }

  /** Read all audit entries for a single insight, oldest first. */
  async listForInsight(insightId: string): Promise<AuditEntryView[]> {
    const rows = await this.prisma.auditEntry.findMany({
      where: { insightId },
      orderBy: { recordedAt: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  /** Read the most recent audit entries (paginated), newest first. */
  async listRecent(page = 1, limit = 50): Promise<{ items: AuditEntryView[]; total: number }> {
    const take = limit > 0 ? limit : 50;
    const skip = (page > 0 ? page - 1 : 0) * take;
    const [rows, total] = await Promise.all([
      this.prisma.auditEntry.findMany({ orderBy: { recordedAt: 'desc' }, skip, take }),
      this.prisma.auditEntry.count(),
    ]);
    return { items: rows.map((r) => this.toView(r)), total };
  }

  private toView(row: {
    id: string;
    eventType: string;
    insightId: string;
    actor: string;
    detail: unknown;
    recordedAt: Date;
  }): AuditEntryView {
    return {
      id: row.id,
      eventType: row.eventType as AuditEventType,
      insightId: row.insightId,
      actor: row.actor,
      detail: (row.detail ?? {}) as Record<string, unknown>,
      recordedAt: row.recordedAt,
    };
  }
}
