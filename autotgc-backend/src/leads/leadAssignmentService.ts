/**
 * LeadAssignmentService — authoritative assigned-lead lookup (Foundation Req 6.3, 6.7).
 *
 * Backs the RBAC assigned-only checks for SALES. One assignment per lead
 * (LeadAssignment.leadId is unique). This complements the denormalized
 * Lead.assignedTo column: `assign()` keeps both consistent so either source can
 * answer "is this lead assigned to this user?".
 */
import type { LeadAssignment, PrismaClient } from '@prisma/client';

export class LeadAssignmentService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Assign a lead to a user (idempotent, one assignment per lead). Mirrors the
   * assignment onto Lead.assignedTo to keep the two sources consistent.
   */
  async assign(leadId: string, userId: string): Promise<LeadAssignment> {
    const assignment = await this.prisma.leadAssignment.upsert({
      where: { leadId },
      update: { userId, assignedAt: new Date() },
      create: { leadId, userId },
    });
    // Best-effort mirror onto the denormalized column; ignore if the lead row is absent.
    await this.prisma.lead
      .update({ where: { leadId }, data: { assignedTo: userId } })
      .catch(() => undefined);
    return assignment;
  }

  /** True iff the lead is currently assigned to the given user. */
  async isAssignedTo(leadId: string, userId: string): Promise<boolean> {
    const assignment = await this.prisma.leadAssignment.findUnique({
      where: { leadId },
      select: { userId: true },
    });
    return assignment !== null && assignment.userId === userId;
  }

  /** All lead ids currently assigned to the given user. */
  async listLeadIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.leadAssignment.findMany({
      where: { userId },
      select: { leadId: true },
    });
    return rows.map((r) => r.leadId);
  }
}
