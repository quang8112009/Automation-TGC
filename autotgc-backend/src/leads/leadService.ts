/**
 * LeadService — CRUD + filtering + stats over the Lead model.
 * Uses pure validation.ts + statusMachine.ts; enforces SALES assigned-only scoping.
 * Lead Management Req 1, 2, 5, 7, 8, 9, 10, 11.
 */
import type { Lead, Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import {
  validateCreateLead,
  validateDateRange,
  UNATTRIBUTED,
} from './validation';
import type { Attribution, CreateLeadInput } from './validation';
import { leadTransition } from './statusMachine';
import type { LeadStatus } from './statusMachine';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../infra/errors';
import type { EventBus } from '../infra/events';

export interface LeadListFilter {
  source?: string;
  platform?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface LeadListResult {
  items: Lead[];
  total: number;
  page: number;
  limit: number;
}

export interface UpdateLeadInput {
  status?: string;
  note?: string | null;
  assignedTo?: string | null;
}

export type StatGroupBy = 'source' | 'platform' | 'date';

export class LeadService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventBus?: EventBus,
  ) {}

  /** Publish a lead domain event (best-effort; never blocks the write path). */
  private async emit(type: 'created' | 'updated', lead: Lead): Promise<void> {
    if (!this.eventBus) return;
    try {
      await this.eventBus.publish({
        topic: 'lead',
        type,
        payload: { id: lead.leadId, status: lead.status, source: lead.source },
      });
    } catch {
      // Event publishing is non-critical; swallow so the request still succeeds.
    }
  }

  async create(input: CreateLeadInput, _actor: AuthInfo): Promise<Lead> {
    const validation = validateCreateLead(input, true);
    if (!validation.ok) {
      throw new ValidationError(validation.message, validation.code);
    }
    const lead = await this.prisma.lead.create({
      data: {
        name: input.name ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        source: input.source as string,
        platform: input.platform as string,
        utmSource: input.utmSource ?? null,
        utmMedium: input.utmMedium ?? null,
        utmCampaign: input.utmCampaign ?? null,
        contentPostId: input.contentPostId as string,
        domainCategory: input.domainCategory ?? null,
        contentTopic: input.contentTopic ?? null,
        status: 'NEW',
        unattributed: false,
      },
    });
    await this.emit('created', lead);
    return lead;
  }

  async createFromWebhook(attribution: Attribution, fields: CreateLeadInput): Promise<Lead> {
    const merged: CreateLeadInput = {
      ...fields,
      source: attribution.source,
      platform: attribution.platform,
      contentPostId: attribution.contentPostId,
    };
    const validation = validateCreateLead(merged, false);
    if (!validation.ok) {
      throw new ValidationError(validation.message, validation.code);
    }
    const lead = await this.prisma.lead.create({
      data: {
        name: fields.name ?? null,
        phone: fields.phone ?? null,
        email: fields.email ?? null,
        source: attribution.source,
        platform: attribution.platform,
        utmSource: fields.utmSource ?? null,
        utmMedium: fields.utmMedium ?? null,
        utmCampaign: fields.utmCampaign ?? null,
        contentPostId: attribution.contentPostId,
        domainCategory: fields.domainCategory ?? null,
        contentTopic: fields.contentTopic ?? null,
        status: 'NEW',
        unattributed: attribution.unattributed,
      },
    });
    await this.emit('created', lead);
    return lead;
  }

  async list(filter: LeadListFilter, page: number, limit: number, actor: AuthInfo): Promise<LeadListResult> {
    const range = validateDateRange(filter.from, filter.to);
    if (!range.ok) {
      throw new ValidationError(range.message, range.code);
    }

    const where: Prisma.LeadWhereInput = {};
    if (filter.source) where.source = filter.source;
    if (filter.platform) where.platform = filter.platform;
    if (filter.status) where.status = filter.status as LeadStatus;
    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(filter.from);
      if (filter.to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(filter.to);
    }
    // SALES sees only its own assigned leads.
    if (actor.role === 'SALES') {
      where.assignedTo = actor.userId;
    }

    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;

    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { items, total, page: safePage, limit: safeLimit };
  }

  async get(id: string, actor: AuthInfo): Promise<Lead & { history: unknown[] }> {
    const lead = await this.prisma.lead.findUnique({ where: { leadId: id } });
    if (!lead) {
      throw new NotFoundError('Lead not found');
    }
    if (actor.role === 'SALES' && lead.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    const history = await this.prisma.leadHistoryEntry.findMany({
      where: { leadId: id },
      orderBy: { changedAt: 'desc' },
    });
    return { ...lead, history };
  }

  async update(id: string, input: UpdateLeadInput, actor: AuthInfo): Promise<Lead> {
    const lead = await this.prisma.lead.findUnique({ where: { leadId: id } });
    if (!lead) {
      throw new NotFoundError('Lead not found');
    }
    if (actor.role === 'SALES' && lead.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }

    const data: Prisma.LeadUpdateInput = {};
    let newStatus: LeadStatus = lead.status as LeadStatus;

    if (input.status !== undefined && input.status !== lead.status) {
      const transition = leadTransition(lead.status as LeadStatus, input.status as LeadStatus);
      if (!transition.ok) {
        throw new ConflictError(
          `Illegal lead status transition ${lead.status} -> ${input.status}`,
          'ILLEGAL_TRANSITION',
        );
      }
      newStatus = transition.status;
      data.status = newStatus;
    }

    if (input.note !== undefined) data.note = input.note;
    if (input.assignedTo !== undefined) {
      data.assignee = input.assignedTo
        ? { connect: { id: input.assignedTo } }
        : { disconnect: true };
    }
    data.updatedAt = new Date();

    const updated = await this.prisma.lead.update({
      where: { leadId: id },
      data,
    });

    await this.prisma.leadHistoryEntry.create({
      data: {
        leadId: id,
        previousStatus: lead.status,
        newStatus,
        note: input.note ?? null,
        assignedTo: input.assignedTo ?? updated.assignedTo ?? null,
        actor: actor.userId,
      },
    });

    await this.emit('updated', updated);
    return updated;
  }

  async delete(id: string, actor: AuthInfo): Promise<void> {
    if (actor.role === 'SALES') {
      throw new ForbiddenError();
    }
    const lead = await this.prisma.lead.findUnique({ where: { leadId: id } });
    if (!lead) {
      throw new NotFoundError('Lead not found');
    }
    await this.prisma.lead.delete({ where: { leadId: id } });
  }

  async stats(
    groupBy: string,
    from: string | undefined,
    to: string | undefined,
    actor: AuthInfo,
  ): Promise<{ groupBy: StatGroupBy; buckets: Array<{ key: string; count: number }> }> {
    if (groupBy !== 'source' && groupBy !== 'platform' && groupBy !== 'date') {
      throw new ValidationError(`Invalid groupBy: ${groupBy}`, 'INVALID_GROUP_BY');
    }
    const range = validateDateRange(from, to);
    if (!range.ok) {
      throw new ValidationError(range.message, range.code);
    }

    const where: Prisma.LeadWhereInput = {};
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(from);
      if (to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(to);
    }
    if (actor.role === 'SALES') {
      where.assignedTo = actor.userId;
    }

    if (groupBy === 'date') {
      // Group by calendar day in application code (DB-agnostic).
      const leads = await this.prisma.lead.findMany({
        where,
        select: { createdAt: true },
      });
      const counts = new Map<string, number>();
      for (const l of leads) {
        const key = l.createdAt.toISOString().slice(0, 10);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const buckets = [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { groupBy, buckets };
    }

    // groupBy field is validated above; cast avoids Prisma's heavy conditional generics.
    const grouped = (await (this.prisma.lead.groupBy as unknown as (args: unknown) => Promise<unknown[]>)({
      by: [groupBy],
      where,
      _count: { _all: true },
    })) as Array<Record<string, unknown> & { _count: { _all: number } }>;
    const buckets = grouped.map((g) => ({
      key: String(g[groupBy]),
      count: g._count._all,
    }));
    return { groupBy, buckets };
  }

  async countByContentPost(contentPostId: string): Promise<number> {
    return this.prisma.lead.count({
      where: {
        contentPostId,
        NOT: { contentPostId: UNATTRIBUTED },
      },
    });
  }

  /**
   * Lead_Analytics_Query feedback-loop input (Lead Management Req 12.3):
   * counts of in-range leads grouped by (domain_category, content_topic).
   */
  async countByCategoryAndTopic(
    from: string,
    to: string,
  ): Promise<Array<{ domainCategory: string; contentTopic: string; count: number }>> {
    const where: Prisma.LeadWhereInput = {
      createdAt: { gte: new Date(from), lte: new Date(to) },
    };
    const leads = await this.prisma.lead.findMany({
      where,
      select: { domainCategory: true, contentTopic: true },
    });
    const counts = new Map<string, { domainCategory: string; contentTopic: string; count: number }>();
    for (const l of leads) {
      const domainCategory = l.domainCategory ?? '';
      const contentTopic = l.contentTopic ?? '';
      const key = `${domainCategory}\u0000${contentTopic}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { domainCategory, contentTopic, count: 1 });
    }
    return [...counts.values()];
  }

  /**
   * Export leads as a CSV or XLSX-compatible file (Lead Management Req 8).
   * SALES is scoped to assigned leads. Returns the file bytes + content type.
   * The "xlsx" format here emits SpreadsheetML-compatible CSV (Excel opens it);
   * a true binary xlsx would require an extra dependency, deferred intentionally.
   */
  async export(
    format: string,
    from: string | undefined,
    to: string | undefined,
    actor: AuthInfo,
  ): Promise<{ filename: string; contentType: string; body: string }> {
    if (format !== 'csv' && format !== 'xlsx') {
      throw new ValidationError(`Invalid export format: ${format}`, 'INVALID_EXPORT_FORMAT');
    }
    const range = validateDateRange(from, to);
    if (!range.ok) {
      throw new ValidationError(range.message, range.code);
    }

    const where: Prisma.LeadWhereInput = {};
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(from);
      if (to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(to);
    }
    if (actor.role === 'SALES') {
      where.assignedTo = actor.userId;
    }

    const leads = await this.prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' } });

    const columns: Array<keyof Lead> = [
      'leadId', 'name', 'phone', 'email', 'source', 'platform',
      'utmSource', 'utmMedium', 'utmCampaign', 'contentPostId',
      'domainCategory', 'contentTopic', 'status', 'assignedTo', 'createdAt',
    ];
    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v instanceof Date ? v.toISOString() : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.join(',');
    const rows = leads.map((lead) => columns.map((c) => escape((lead as Record<string, unknown>)[c])).join(','));
    const body = [header, ...rows].join('\n');

    return {
      filename: `leads-export.${format === 'xlsx' ? 'csv' : 'csv'}`,
      contentType: format === 'xlsx' ? 'application/vnd.ms-excel' : 'text/csv',
      body,
    };
  }
}
