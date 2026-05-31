/**
 * Property-based tests for the lead-management-dashboard spec.
 *
 * These fill the gaps left by the existing suites:
 *   - test/leadsAndInfra.test.ts   -> P2-P4 (partial create validation), P8, P18, P26, P28
 *   - test/stateMachines.test.ts   -> P12 (lead status transition closure)
 *   - test/auth.test.ts            -> P22 / P30 (RBAC at the policy level)
 *
 * Everything here uses only existing exports from src/ (no source changes). The
 * Lead repository is an in-memory fake of the small PrismaClient surface that
 * LeadService actually calls; the dashboard properties exercise the pure
 * exported assembler helpers directly.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Lead, PrismaClient } from '@prisma/client';
import { LeadService } from '../src/leads/leadService';
import type { AuthInfo } from '../src/http/authMiddleware';
import {
  LEAD_SOURCES,
  LEAD_PLATFORMS,
  UNATTRIBUTED,
  parseFacebookLeadgen,
  parseWebsiteForm,
} from '../src/leads/validation';
import { AppError } from '../src/infra/errors';
import {
  buildApprovalQueue,
  compareApprovalItems,
  buildAlertSection,
  buildNotifications,
  assembleOverview,
} from '../src/dashboard/assembler';
import type {
  ApprovalQueueItem,
  DraftLike,
  InsightLike,
  ScheduledPostLike,
  TokenExpiryWarning,
} from '../src/dashboard/assembler';

// --------------------------------------------------------------------------
// In-memory Prisma fake (only the methods LeadService calls)
// --------------------------------------------------------------------------

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  by?: string[];
  skip?: number;
  take?: number;
};

/** Mirror the subset of Prisma `where` semantics LeadService relies on. */
function matchWhere(lead: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const key of Object.keys(where)) {
    const cond = (where as Record<string, unknown>)[key];
    if (cond === undefined) continue;
    if (key === 'NOT') {
      if (matchWhere(lead, cond as Record<string, unknown>)) return false;
      continue;
    }
    if (key === 'createdAt') {
      const range = cond as { gte?: unknown; lte?: unknown };
      const t = (lead.createdAt as Date).getTime();
      if (range.gte !== undefined && t < new Date(range.gte as string | number | Date).getTime()) return false;
      if (range.lte !== undefined && t > new Date(range.lte as string | number | Date).getTime()) return false;
      continue;
    }
    if (lead[key] !== cond) return false;
  }
  return true;
}

interface FakeHistoryEntry {
  id: string;
  leadId: string;
  previousStatus: string;
  newStatus: string;
  note: string | null;
  assignedTo: string | null;
  actor: string;
  changedAt: Date;
}

class FakePrisma {
  leads: Lead[] = [];
  histories: FakeHistoryEntry[] = [];
  private tick = 0;
  private histTick = 0;
  // Created leads sit in the past so a real `new Date()` on update is strictly later.
  private static readonly CREATE_BASE = Date.UTC(2020, 0, 1);

  seed(records: Lead[]): void {
    for (const r of records) this.leads.push(r);
  }

  lead = {
    create: async ({ data }: AnyArgs): Promise<Lead> => {
      this.tick += 1;
      const d = data as Record<string, unknown>;
      const t = new Date(FakePrisma.CREATE_BASE + this.tick * 1000); // unique + ordered
      const lead = {
        leadId: (d.leadId as string) ?? `lead-${this.tick}`,
        name: (d.name as string | null) ?? null,
        phone: (d.phone as string | null) ?? null,
        email: (d.email as string | null) ?? null,
        source: d.source as string,
        platform: d.platform as string,
        utmSource: (d.utmSource as string | null) ?? null,
        utmMedium: (d.utmMedium as string | null) ?? null,
        utmCampaign: (d.utmCampaign as string | null) ?? null,
        contentPostId: d.contentPostId as string,
        domainCategory: (d.domainCategory as string | null) ?? null,
        contentTopic: (d.contentTopic as string | null) ?? null,
        status: (d.status as string) ?? 'NEW',
        note: (d.note as string | null) ?? null,
        assignedTo: (d.assignedTo as string | null) ?? null,
        unattributed: (d.unattributed as boolean) ?? false,
        createdAt: t,
        updatedAt: t,
      } as unknown as Lead;
      this.leads.push(lead);
      return { ...lead };
    },
    findUnique: async ({ where }: AnyArgs): Promise<Lead | null> => {
      const l = this.leads.find((x) => x.leadId === (where as { leadId: string }).leadId);
      return l ? { ...l } : null;
    },
    findMany: async ({ where, orderBy, skip, take }: AnyArgs): Promise<Lead[]> => {
      let res = this.leads.filter((l) => matchWhere(l as unknown as Record<string, unknown>, where ?? {}));
      const ord = orderBy as { createdAt?: 'asc' | 'desc' } | undefined;
      if (ord?.createdAt === 'desc') res = [...res].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      else if (ord?.createdAt === 'asc') res = [...res].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (typeof skip === 'number') res = res.slice(skip);
      if (typeof take === 'number') res = res.slice(0, take);
      return res.map((l) => ({ ...l }));
    },
    count: async ({ where }: AnyArgs): Promise<number> =>
      this.leads.filter((l) => matchWhere(l as unknown as Record<string, unknown>, where ?? {})).length,
    update: async ({ where, data }: AnyArgs): Promise<Lead> => {
      const l = this.leads.find((x) => x.leadId === (where as { leadId: string }).leadId);
      if (!l) throw new Error('Record to update not found');
      const d = data as Record<string, unknown>;
      if (d.status !== undefined) (l as unknown as Record<string, unknown>).status = d.status;
      if (d.note !== undefined) l.note = d.note as string | null;
      if (d.assignee !== undefined) {
        const a = d.assignee as { connect?: { id: string }; disconnect?: boolean };
        if (a.connect) l.assignedTo = a.connect.id;
        else if (a.disconnect) l.assignedTo = null;
      }
      if (d.updatedAt !== undefined) {
        l.updatedAt = d.updatedAt instanceof Date ? d.updatedAt : new Date(d.updatedAt as string | number);
      }
      return { ...l };
    },
    delete: async ({ where }: AnyArgs): Promise<Lead> => {
      const i = this.leads.findIndex((x) => x.leadId === (where as { leadId: string }).leadId);
      if (i === -1) throw new Error('Record to delete does not exist');
      const [removed] = this.leads.splice(i, 1);
      return { ...removed };
    },
    groupBy: async ({ by, where }: AnyArgs): Promise<Array<Record<string, unknown>>> => {
      const field = (by as string[])[0];
      const filtered = this.leads.filter((l) => matchWhere(l as unknown as Record<string, unknown>, where ?? {}));
      const counts = new Map<unknown, number>();
      for (const l of filtered) {
        const k = (l as unknown as Record<string, unknown>)[field];
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts.entries()].map(([k, c]) => ({ [field]: k, _count: { _all: c } }));
    },
  };

  leadHistoryEntry = {
    create: async ({ data }: AnyArgs): Promise<FakeHistoryEntry> => {
      this.histTick += 1;
      const d = data as Record<string, unknown>;
      const entry: FakeHistoryEntry = {
        id: `hist-${this.histTick}`,
        leadId: d.leadId as string,
        previousStatus: d.previousStatus as string,
        newStatus: d.newStatus as string,
        note: (d.note as string | null) ?? null,
        assignedTo: (d.assignedTo as string | null) ?? null,
        actor: d.actor as string,
        changedAt: new Date(FakePrisma.CREATE_BASE + 10_000_000_000 + this.histTick * 1000),
      };
      this.histories.push(entry);
      return { ...entry };
    },
    findMany: async ({ where, orderBy }: AnyArgs): Promise<FakeHistoryEntry[]> => {
      let res = this.histories.filter((h) => h.leadId === (where as { leadId: string }).leadId);
      const ord = orderBy as { changedAt?: 'asc' | 'desc' } | undefined;
      if (ord?.changedAt === 'desc') res = [...res].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
      else if (ord?.changedAt === 'asc') res = [...res].sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
      return res.map((h) => ({ ...h }));
    },
  };
}

function newService(): { prisma: FakePrisma; service: LeadService } {
  const prisma = new FakePrisma();
  const service = new LeadService(prisma as unknown as PrismaClient);
  return { prisma, service };
}

// --------------------------------------------------------------------------
// Shared actors + helpers
// --------------------------------------------------------------------------

const admin: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sa' };
const salesA: AuthInfo = { userId: 'sales-A', role: 'SALES', sessionId: 'sb' };

const DAY_MS = 86_400_000;
const DAY_BASE = Date.UTC(2026, 0, 1);
const dayIso = (day: number): string => new Date(DAY_BASE + day * DAY_MS).toISOString();

function makeLead(p: {
  leadId: string;
  source: string;
  platform: string;
  contentPostId: string;
  status?: string;
  day?: number;
  assignedTo?: string | null;
  domainCategory?: string | null;
  contentTopic?: string | null;
}): Lead {
  const created = new Date(DAY_BASE + (p.day ?? 0) * DAY_MS);
  return {
    leadId: p.leadId,
    name: null,
    phone: '0900000000',
    email: null,
    source: p.source,
    platform: p.platform,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    contentPostId: p.contentPostId,
    domainCategory: p.domainCategory ?? null,
    contentTopic: p.contentTopic ?? null,
    status: (p.status ?? 'NEW') as unknown as Lead['status'],
    note: null,
    assignedTo: p.assignedTo ?? null,
    unattributed: p.contentPostId === UNATTRIBUTED,
    createdAt: created,
    updatedAt: created,
  } as unknown as Lead;
}

const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'] as const;

const sourceArb = fc.constantFrom(...LEAD_SOURCES);
const platformArb = fc.constantFrom(...LEAD_PLATFORMS);
const statusArb = fc.constantFrom(...LEAD_STATUSES);

/** A create input that always passes validation (non-blank phone, content_post_id, valid enums). */
const validCreateArb = fc.record({
  name: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  phone: fc.constantFrom('0900000001', '0900000002', '+84901234567'),
  email: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  source: sourceArb,
  platform: platformArb,
  contentPostId: fc.constantFrom('post-1', 'post-2', 'post-3'),
  utmSource: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  utmMedium: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  utmCampaign: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  domainCategory: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  contentTopic: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
});

function statusForServiceFromError(e: unknown): number | undefined {
  return e instanceof AppError ? e.status : undefined;
}

describe('lead-management-dashboard properties', () => {
  // ----------------------------------------------------------------------
  // Lead_Service create / read
  // ----------------------------------------------------------------------

  // Feature: lead-management-dashboard, Property 1: Lead creation invariants
  it('Property 1: created leads get a unique id, status=NEW, updatedAt==createdAt', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(validCreateArb, { minLength: 1, maxLength: 10 }), async (inputs) => {
        const { service } = newService();
        const ids = new Set<string>();
        for (const input of inputs) {
          const lead = await service.create(input, admin);
          expect(lead.status).toBe('NEW');
          expect(lead.updatedAt.getTime()).toBe(lead.createdAt.getTime());
          expect(ids.has(lead.leadId)).toBe(false);
          ids.add(lead.leadId);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 3: required content_post_id on direct creation
  it('Property 3: direct create without content_post_id is rejected 400 and creates nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          phone: fc.constantFrom('0900000001', '0900000002'),
          source: sourceArb,
          platform: platformArb,
          contentPostId: fc.option(fc.constantFrom('', '   '), { nil: undefined }),
        }),
        async (input) => {
          const { prisma, service } = newService();
          let status: number | undefined;
          try {
            await service.create(input, admin);
          } catch (e) {
            status = statusForServiceFromError(e);
          }
          expect(status).toBe(400);
          expect(prisma.leads.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 4: enum validation for source and platform
  it('Property 4: invalid source/platform is rejected 400 (identified) and creates nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          phone: fc.constantFrom('0900000001'),
          contentPostId: fc.constantFrom('post-1'),
          source: fc.oneof(sourceArb, fc.constantFrom('bogus_source', 'sms', '')),
          platform: fc.oneof(platformArb, fc.constantFrom('zalo', 'instagram', '')),
        }),
        async (input) => {
          const { prisma, service } = newService();
          const validSource = (LEAD_SOURCES as readonly string[]).includes(input.source);
          const validPlatform = (LEAD_PLATFORMS as readonly string[]).includes(input.platform);
          let status: number | undefined;
          let message = '';
          try {
            await service.create(input, admin);
          } catch (e) {
            status = statusForServiceFromError(e);
            message = e instanceof Error ? e.message : '';
          }
          if (validSource && validPlatform) {
            expect(status).toBeUndefined();
            expect(prisma.leads.length).toBe(1);
          } else {
            expect(status).toBe(400);
            expect(prisma.leads.length).toBe(0);
            // message identifies the offending value
            if (!validSource) expect(message).toContain(String(input.source));
            else expect(message).toContain(String(input.platform));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: lead-management-dashboard, Property 5: attribute storage round-trip
  it('Property 5: utm/domain/topic written on create are read back unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(validCreateArb, async (input) => {
        const { service } = newService();
        const created = await service.create(input, admin);
        const detail = await service.get(created.leadId, admin);
        expect(detail.utmSource).toBe(input.utmSource ?? null);
        expect(detail.utmMedium).toBe(input.utmMedium ?? null);
        expect(detail.utmCampaign).toBe(input.utmCampaign ?? null);
        expect(detail.domainCategory).toBe(input.domainCategory ?? null);
        expect(detail.contentTopic).toBe(input.contentTopic ?? null);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 6: pagination invariant
  it('Property 6: pages partition the matching set with no dupes/omissions, total is exact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validCreateArb, { minLength: 0, maxLength: 16 }),
        fc.integer({ min: 1, max: 6 }),
        async (inputs, limit) => {
          const { service } = newService();
          const created: string[] = [];
          for (const input of inputs) created.push((await service.create(input, admin)).leadId);
          const total = created.length;
          const pages = total === 0 ? 1 : Math.ceil(total / limit);
          const seen: string[] = [];
          for (let page = 1; page <= pages; page += 1) {
            const res = await service.list({}, page, limit, admin);
            expect(res.total).toBe(total);
            expect(res.items.length).toBeLessThanOrEqual(limit);
            for (const item of res.items) seen.push(item.leadId);
          }
          // no duplicates
          expect(new Set(seen).size).toBe(seen.length);
          // exactly the created set
          expect(new Set(seen)).toEqual(new Set(created));
          expect(seen.length).toBe(total);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 7: filter correctness and composition (AND, inclusive range)
  it('Property 7: filtered list equals the naive reference over every present filter', async () => {
    const leadSpecArb = fc.record({
      source: sourceArb,
      platform: platformArb,
      status: statusArb,
      day: fc.integer({ min: 0, max: 20 }),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { maxLength: 14 }),
        fc.record({
          source: fc.option(sourceArb, { nil: undefined }),
          platform: fc.option(platformArb, { nil: undefined }),
          status: fc.option(statusArb, { nil: undefined }),
          fromDay: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
          toDay: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
        }),
        async (specs, raw) => {
          const { prisma, service } = newService();
          const leads = specs.map((s, i) =>
            makeLead({ leadId: `L${i}`, source: s.source, platform: s.platform, contentPostId: 'post-1', status: s.status, day: s.day }),
          );
          prisma.seed(leads);

          // Ensure from <= to so date-range validation passes (from > to is P8).
          let from: string | undefined;
          let to: string | undefined;
          if (raw.fromDay !== undefined && raw.toDay !== undefined) {
            const lo = Math.min(raw.fromDay, raw.toDay);
            const hi = Math.max(raw.fromDay, raw.toDay);
            from = dayIso(lo);
            to = dayIso(hi);
          } else {
            from = raw.fromDay !== undefined ? dayIso(raw.fromDay) : undefined;
            to = raw.toDay !== undefined ? dayIso(raw.toDay) : undefined;
          }
          const filter = { source: raw.source, platform: raw.platform, status: raw.status, from, to };

          const res = await service.list(filter, 1, 1000, admin);

          const reference = leads.filter((l) => {
            if (raw.source !== undefined && l.source !== raw.source) return false;
            if (raw.platform !== undefined && l.platform !== raw.platform) return false;
            if (raw.status !== undefined && (l.status as unknown as string) !== raw.status) return false;
            const t = l.createdAt.getTime();
            if (from !== undefined && t < new Date(from).getTime()) return false;
            if (to !== undefined && t > new Date(to).getTime()) return false;
            return true;
          });

          expect(new Set(res.items.map((l) => l.leadId))).toEqual(new Set(reference.map((l) => l.leadId)));
          expect(res.total).toBe(reference.length);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: lead-management-dashboard, Property 9: interaction-history presence and ordering
  it('Property 9: detail returns full history ordered most-recent-first', async () => {
    await fc.assert(
      fc.asyncProperty(validCreateArb, fc.integer({ min: 1, max: 6 }), async (input, updates) => {
        const { service } = newService();
        const lead = await service.create(input, admin);
        for (let i = 0; i < updates; i += 1) {
          await service.update(lead.leadId, { note: `n${i}` }, admin);
        }
        const detail = await service.get(lead.leadId, admin);
        const history = detail.history as Array<{ changedAt: Date }>;
        expect(history.length).toBe(updates);
        for (let i = 1; i < history.length; i += 1) {
          expect(history[i - 1].changedAt.getTime()).toBeGreaterThanOrEqual(history[i].changedAt.getTime());
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 10: not-found leaves store unchanged
  it('Property 10: get/update/delete on an absent id -> 404 and no mutation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validCreateArb, { maxLength: 5 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.constantFrom('get', 'update', 'delete'),
        async (inputs, missingId, op) => {
          const { prisma, service } = newService();
          for (const input of inputs) await service.create(input, admin);
          // Guarantee the id is absent.
          if (prisma.leads.some((l) => l.leadId === missingId)) return;
          const before = prisma.leads.map((l) => ({ ...l }));
          const histBefore = prisma.histories.length;

          let status: number | undefined;
          try {
            if (op === 'get') await service.get(missingId, admin);
            else if (op === 'update') await service.update(missingId, { note: 'x' }, admin);
            else await service.delete(missingId, admin);
          } catch (e) {
            status = statusForServiceFromError(e);
          }
          expect(status).toBe(404);
          expect(prisma.leads.map((l) => ({ ...l }))).toEqual(before);
          expect(prisma.histories.length).toBe(histBefore);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 11: update applies fields and appends exactly one history entry
  it('Property 11: each accepted update applies changes and appends exactly one history entry', async () => {
    await fc.assert(
      fc.asyncProperty(
        validCreateArb,
        fc.string({ maxLength: 8 }),
        fc.string({ maxLength: 8 }),
        async (input, noteA, noteB) => {
          const { prisma, service } = newService();
          const lead = await service.create(input, admin);

          // Update A: note only (status stays NEW).
          await service.update(lead.leadId, { note: noteA }, admin);
          expect(prisma.histories.length).toBe(1);
          const entryA = { ...prisma.histories[0] };
          expect(entryA.previousStatus).toBe('NEW');
          expect(entryA.newStatus).toBe('NEW');
          expect(entryA.actor).toBe(admin.userId);
          expect(entryA.note).toBe(noteA);

          // Update B: legal NEW -> CONTACTED with a note.
          const updatedB = await service.update(lead.leadId, { status: 'CONTACTED', note: noteB }, admin);
          expect(prisma.histories.length).toBe(2);
          // prior entry left unchanged
          expect(prisma.histories[0]).toEqual(entryA);
          expect(prisma.histories[1].previousStatus).toBe('NEW');
          expect(prisma.histories[1].newStatus).toBe('CONTACTED');
          expect(updatedB.status).toBe('CONTACTED');
          expect(updatedB.note).toBe(noteB);
          expect(updatedB.updatedAt.getTime()).toBeGreaterThanOrEqual(lead.createdAt.getTime());
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 11: illegal transition -> 409, no history appended
  it('Property 11: an illegal status transition returns 409 with status unchanged and no history', async () => {
    await fc.assert(
      fc.asyncProperty(validCreateArb, fc.constantFrom('QUALIFIED', 'CONVERTED'), async (input, illegalTarget) => {
        const { prisma, service } = newService();
        const lead = await service.create(input, admin);
        let status: number | undefined;
        try {
          await service.update(lead.leadId, { status: illegalTarget }, admin);
        } catch (e) {
          status = statusForServiceFromError(e);
        }
        expect(status).toBe(409);
        expect(prisma.histories.length).toBe(0);
        const reread = await service.get(lead.leadId, admin);
        expect(reread.status).toBe('NEW');
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 13: delete round-trip
  it('Property 13: an ADMIN delete makes a subsequent read return 404', async () => {
    await fc.assert(
      fc.asyncProperty(validCreateArb, async (input) => {
        const { service } = newService();
        const lead = await service.create(input, admin);
        await service.delete(lead.leadId, admin);
        let status: number | undefined;
        try {
          await service.get(lead.leadId, admin);
        } catch (e) {
          status = statusForServiceFromError(e);
        }
        expect(status).toBe(404);
      }),
      { numRuns: 100 },
    );
  });

  // ----------------------------------------------------------------------
  // Lead_Service stats / export
  // ----------------------------------------------------------------------

  // Feature: lead-management-dashboard, Property 14: stats grouping correctness
  it('Property 14: per-group counts equal a naive grouping and sum to the in-range total', async () => {
    const leadSpecArb = fc.record({ source: sourceArb, platform: platformArb, day: fc.integer({ min: 0, max: 15 }) });
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { maxLength: 16 }),
        fc.constantFrom('source', 'platform', 'date'),
        fc.option(fc.integer({ min: 0, max: 15 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 15 }), { nil: undefined }),
        async (specs, groupBy, fromDayRaw, toDayRaw) => {
          const { prisma, service } = newService();
          const leads = specs.map((s, i) =>
            makeLead({ leadId: `L${i}`, source: s.source, platform: s.platform, contentPostId: 'post-1', day: s.day }),
          );
          prisma.seed(leads);

          let from: string | undefined;
          let to: string | undefined;
          if (fromDayRaw !== undefined && toDayRaw !== undefined) {
            from = dayIso(Math.min(fromDayRaw, toDayRaw));
            to = dayIso(Math.max(fromDayRaw, toDayRaw));
          } else {
            from = fromDayRaw !== undefined ? dayIso(fromDayRaw) : undefined;
            to = toDayRaw !== undefined ? dayIso(toDayRaw) : undefined;
          }

          const res = await service.stats(groupBy, from, to, admin);

          const inRange = leads.filter((l) => {
            const t = l.createdAt.getTime();
            if (from !== undefined && t < new Date(from).getTime()) return false;
            if (to !== undefined && t > new Date(to).getTime()) return false;
            return true;
          });
          const ref = new Map<string, number>();
          for (const l of inRange) {
            const key =
              groupBy === 'date' ? l.createdAt.toISOString().slice(0, 10) : String((l as unknown as Record<string, unknown>)[groupBy]);
            ref.set(key, (ref.get(key) ?? 0) + 1);
          }

          const got = new Map(res.buckets.map((b) => [b.key, b.count]));
          expect(got).toEqual(ref);
          const sum = res.buckets.reduce((acc, b) => acc + b.count, 0);
          expect(sum).toBe(inRange.length);
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: lead-management-dashboard, Property 15: invalid stats dimension rejected
  it('Property 15: a group_by outside {source,platform,date} -> 400 identifying the dimension', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 12 }).filter((s) => s !== 'source' && s !== 'platform' && s !== 'date'),
        async (groupBy) => {
          const { service } = newService();
          let status: number | undefined;
          let message = '';
          try {
            await service.stats(groupBy, undefined, undefined, admin);
          } catch (e) {
            status = statusForServiceFromError(e);
            message = e instanceof Error ? e.message : '';
          }
          expect(status).toBe(400);
          expect(message).toContain(groupBy);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 16: export round-trip and format validation
  it('Property 16: parsing the export yields exactly the in-range leads; bad format -> 400', async () => {
    const leadSpecArb = fc.record({ source: sourceArb, platform: platformArb, day: fc.integer({ min: 0, max: 15 }) });
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { maxLength: 14 }),
        fc.constantFrom('csv', 'xlsx'),
        fc.option(fc.integer({ min: 0, max: 15 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 15 }), { nil: undefined }),
        async (specs, format, fromDayRaw, toDayRaw) => {
          const { prisma, service } = newService();
          const leads = specs.map((s, i) =>
            makeLead({ leadId: `L${i}`, source: s.source, platform: s.platform, contentPostId: `post-${i}`, day: s.day }),
          );
          prisma.seed(leads);

          let from: string | undefined;
          let to: string | undefined;
          if (fromDayRaw !== undefined && toDayRaw !== undefined) {
            from = dayIso(Math.min(fromDayRaw, toDayRaw));
            to = dayIso(Math.max(fromDayRaw, toDayRaw));
          } else {
            from = fromDayRaw !== undefined ? dayIso(fromDayRaw) : undefined;
            to = toDayRaw !== undefined ? dayIso(toDayRaw) : undefined;
          }

          const file = await service.export(format, from, to, admin);
          const lines = file.body.split('\n');
          const dataRows = lines.slice(1).filter((l) => l.length > 0);
          const exportedIds = dataRows.map((r) => r.split(',')[0]); // leadId is column 0; seeded values have no commas

          const inRange = leads.filter((l) => {
            const t = l.createdAt.getTime();
            if (from !== undefined && t < new Date(from).getTime()) return false;
            if (to !== undefined && t > new Date(to).getTime()) return false;
            return true;
          });
          expect(new Set(exportedIds)).toEqual(new Set(inRange.map((l) => l.leadId)));
          expect(exportedIds.length).toBe(inRange.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 16: invalid export format rejected
  it('Property 16: an unsupported export format -> 400 and no file', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 10 }).filter((s) => s !== 'csv' && s !== 'xlsx'),
        async (format) => {
          const { service } = newService();
          let status: number | undefined;
          try {
            await service.export(format, undefined, undefined, admin);
          } catch (e) {
            status = statusForServiceFromError(e);
          }
          expect(status).toBe(400);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 17: SALES scope restriction on list/stats/export
  it('Property 17: SALES list/stats/export only ever touch leads assigned to that consultant', async () => {
    const owners = [salesA.userId, 'sales-B', null] as const;
    const leadSpecArb = fc.record({
      source: sourceArb,
      platform: platformArb,
      day: fc.integer({ min: 0, max: 10 }),
      owner: fc.constantFrom(...owners),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(leadSpecArb, { maxLength: 18 }), async (specs) => {
        const { prisma, service } = newService();
        const leads = specs.map((s, i) =>
          makeLead({ leadId: `L${i}`, source: s.source, platform: s.platform, contentPostId: 'post-1', day: s.day, assignedTo: s.owner }),
        );
        prisma.seed(leads);

        const mine = leads.filter((l) => l.assignedTo === salesA.userId);

        // list
        const list = await service.list({}, 1, 1000, salesA);
        expect(list.items.every((l) => l.assignedTo === salesA.userId)).toBe(true);
        expect(new Set(list.items.map((l) => l.leadId))).toEqual(new Set(mine.map((l) => l.leadId)));

        // stats — counts only assigned
        const stats = await service.stats('source', undefined, undefined, salesA);
        const statsSum = stats.buckets.reduce((acc, b) => acc + b.count, 0);
        expect(statsSum).toBe(mine.length);

        // export — only assigned rows
        const file = await service.export('csv', undefined, undefined, salesA);
        const ids = file.body
          .split('\n')
          .slice(1)
          .filter((l) => l.length > 0)
          .map((r) => r.split(',')[0]);
        expect(new Set(ids)).toEqual(new Set(mine.map((l) => l.leadId)));
      }),
      { numRuns: 100 },
    );
  });

  // ----------------------------------------------------------------------
  // Lead_Analytics_Query
  // ----------------------------------------------------------------------

  // Feature: lead-management-dashboard, Property 20: per-post lead-count excludes unattributed
  it('Property 20: countByContentPost equals the count for that post, excluding unattributed', async () => {
    const postIds = ['post-1', 'post-2', UNATTRIBUTED] as const;
    const leadSpecArb = fc.record({ source: sourceArb, platform: platformArb, post: fc.constantFrom(...postIds) });
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { maxLength: 18 }),
        fc.constantFrom('post-1', 'post-2', 'post-3', UNATTRIBUTED),
        async (specs, target) => {
          const { prisma, service } = newService();
          const leads = specs.map((s, i) => makeLead({ leadId: `L${i}`, source: s.source, platform: s.platform, contentPostId: s.post }));
          prisma.seed(leads);

          const count = await service.countByContentPost(target);
          const reference =
            target === UNATTRIBUTED ? 0 : leads.filter((l) => l.contentPostId === target && l.contentPostId !== UNATTRIBUTED).length;
          expect(count).toBe(reference);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 21: category-and-topic lead-count correctness
  it('Property 21: countByCategoryAndTopic matches a naive (domain_category, content_topic) grouping in range', async () => {
    const cats = ['c1', 'c2', null] as const;
    const topics = ['t1', 't2', null] as const;
    const leadSpecArb = fc.record({
      source: sourceArb,
      platform: platformArb,
      day: fc.integer({ min: 0, max: 15 }),
      cat: fc.constantFrom(...cats),
      topic: fc.constantFrom(...topics),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { maxLength: 16 }),
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 0, max: 15 }),
        async (specs, d0, d1) => {
          const { prisma, service } = newService();
          const leads = specs.map((s, i) =>
            makeLead({
              leadId: `L${i}`,
              source: s.source,
              platform: s.platform,
              contentPostId: 'post-1',
              day: s.day,
              domainCategory: s.cat,
              contentTopic: s.topic,
            }),
          );
          prisma.seed(leads);
          const from = dayIso(Math.min(d0, d1));
          const to = dayIso(Math.max(d0, d1));

          const result = await service.countByCategoryAndTopic(from, to);

          const inRange = leads.filter((l) => {
            const t = l.createdAt.getTime();
            return t >= new Date(from).getTime() && t <= new Date(to).getTime();
          });
          const ref = new Map<string, number>();
          for (const l of inRange) {
            const key = `${l.domainCategory ?? ''}\u0000${l.contentTopic ?? ''}`;
            ref.set(key, (ref.get(key) ?? 0) + 1);
          }
          const got = new Map(result.map((r) => [`${r.domainCategory}\u0000${r.contentTopic}`, r.count]));
          expect(got).toEqual(ref);
        },
      ),
      { numRuns: 150 },
    );
  });

  // ----------------------------------------------------------------------
  // Webhook parsing
  // ----------------------------------------------------------------------

  // Feature: lead-management-dashboard, Property 19: webhook parse rejection
  it('Property 19: non-object verified bodies are unparseable (null); objects parse', async () => {
    await fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.anything()),
          fc.object(),
        ),
        (raw) => {
          const isPlainObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
          expect(parseFacebookLeadgen(raw)).toEqual(isPlainObject ? expect.anything() : null);
          expect(parseWebsiteForm(raw)).toEqual(isPlainObject ? expect.anything() : null);
          if (!isPlainObject) {
            expect(parseFacebookLeadgen(raw)).toBeNull();
            expect(parseWebsiteForm(raw)).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // ----------------------------------------------------------------------
  // Dashboard pure assembler helpers
  // ----------------------------------------------------------------------

  const contentStatusArb = fc.constantFrom('DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'FAILED');
  const insightStatusArb = fc.constantFrom('NEW', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');
  const platArb = fc.constantFrom('facebook', 'tiktok', 'website');
  const isoArb = fc.integer({ min: 0, max: 60 }).map((d) => dayIso(d));
  const optIsoArb = fc.option(isoArb, { nil: null });

  // Feature: lead-management-dashboard, Property 24: approval-queue composition
  it('Property 24: queue contains exactly DRAFT drafts ∪ PENDING_REVIEW insights', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ status: contentStatusArb, title: fc.string({ maxLength: 6 }), createdAt: isoArb }), { maxLength: 12 }),
        fc.array(fc.record({ insightStatus: insightStatusArb, title: fc.string({ maxLength: 6 }), createdAt: isoArb }), { maxLength: 12 }),
        (draftSpecs, insightSpecs) => {
          const drafts: DraftLike[] = draftSpecs.map((d, i) => ({ id: `D${i}`, status: d.status, title: d.title, createdAt: d.createdAt }));
          const insights: InsightLike[] = insightSpecs.map((s, i) => ({
            id: `I${i}`,
            insightStatus: s.insightStatus,
            title: s.title,
            createdAt: s.createdAt,
          }));
          const queue = buildApprovalQueue(drafts, insights);

          const expectedDraftIds = drafts.filter((d) => d.status === 'DRAFT').map((d) => d.id);
          const expectedInsightIds = insights.filter((s) => s.insightStatus === 'PENDING_REVIEW').map((s) => s.id);
          const expected = new Set([...expectedDraftIds, ...expectedInsightIds]);

          expect(new Set(queue.map((q) => q.id))).toEqual(expected);
          expect(queue.length).toBe(expected.size);
          for (const item of queue) {
            if (item.id.startsWith('D')) expect(item.kind).toBe('DRAFT');
            else expect(item.kind).toBe('INSIGHT');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: lead-management-dashboard, Property 25: approval-queue ordering
  it('Property 25: ordering is consistent — deadline items first (nearest first), then newest-created', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), createdAt: isoArb, deadlineAt: optIsoArb }), { maxLength: 14 }),
        (specs) => {
          const items: ApprovalQueueItem[] = specs.map((s, i) => ({
            kind: i % 2 === 0 ? 'DRAFT' : 'INSIGHT',
            id: `${s.id}-${i}`,
            createdAt: s.createdAt,
            deadlineAt: s.deadlineAt,
            title: 't',
          }));
          const sorted = [...items].sort(compareApprovalItems);
          // adjacent pairs respect the comparator
          for (let i = 1; i < sorted.length; i += 1) {
            expect(compareApprovalItems(sorted[i - 1], sorted[i])).toBeLessThanOrEqual(0);
          }
          // all deadline-bearing items precede deadline-less items
          let seenNullDeadline = false;
          for (const it of sorted) {
            if (it.deadlineAt === null) seenNullDeadline = true;
            else expect(seenNullDeadline).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: lead-management-dashboard, Property 27: alert-section composition
  it('Property 27: alert section contains exactly FAILED posts (with reason) plus token warnings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ status: contentStatusArb, failureReason: fc.option(fc.string({ maxLength: 8 }), { nil: null }) }),
          { maxLength: 14 },
        ),
        fc.array(fc.record({ platform: platArb, reason: fc.string({ maxLength: 8 }) }), { maxLength: 6 }),
        (postSpecs, warnSpecs) => {
          const posts: ScheduledPostLike[] = postSpecs.map((p, i) => ({
            id: `P${i}`,
            platform: 'facebook',
            status: p.status,
            scheduledPublishTime: dayIso(i),
            title: 't',
            failureReason: p.failureReason,
          }));
          const warnings: TokenExpiryWarning[] = warnSpecs.map((w) => ({ platform: w.platform, reason: w.reason }));

          const alerts = buildAlertSection(posts, warnings);
          const failedAlerts = alerts.filter((a) => a.kind === 'FAILED_POST');
          const tokenAlerts = alerts.filter((a) => a.kind === 'TOKEN_EXPIRY');

          const expectedFailed = posts.filter((p) => p.status === 'FAILED');
          expect(new Set(failedAlerts.map((a) => a.ref))).toEqual(new Set(expectedFailed.map((p) => p.id)));
          expect(tokenAlerts.length).toBe(warnings.length);
          // each failed-post alert carries its reason (or UNKNOWN)
          for (const p of expectedFailed) {
            const alert = failedAlerts.find((a) => a.ref === p.id);
            expect(alert?.reason).toBe(p.failureReason ?? 'UNKNOWN');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: lead-management-dashboard, Property 23: overview completeness
  it('Property 23: an assembled overview always includes all five sections', () => {
    fc.assert(
      fc.property(
        fc.record({
          drafts: fc.array(fc.record({ status: contentStatusArb, title: fc.string({ maxLength: 4 }), createdAt: isoArb }), { maxLength: 6 }),
          insights: fc.array(fc.record({ insightStatus: insightStatusArb, title: fc.string({ maxLength: 4 }), createdAt: isoArb }), {
            maxLength: 6,
          }),
          posts: fc.array(fc.record({ status: contentStatusArb, when: fc.integer({ min: 0, max: 20 }) }), { maxLength: 6 }),
          lastSyncDay: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
        }),
        (input) => {
          const drafts: DraftLike[] = input.drafts.map((d, i) => ({ id: `D${i}`, status: d.status, title: d.title, createdAt: d.createdAt }));
          const insights: InsightLike[] = input.insights.map((s, i) => ({
            id: `I${i}`,
            insightStatus: s.insightStatus,
            title: s.title,
            createdAt: s.createdAt,
          }));
          const scheduledPosts: ScheduledPostLike[] = input.posts.map((p, i) => ({
            id: `P${i}`,
            platform: 'website',
            status: p.status,
            scheduledPublishTime: dayIso(p.when),
            title: 't',
          }));
          const now = new Date(DAY_BASE);
          const lastSync = input.lastSyncDay === null ? null : new Date(DAY_BASE + input.lastSyncDay * DAY_MS);
          const kpi = { view: { total: 1 }, lead: { total: 2 }, follow: { total: 3 } };

          const overview = assembleOverview({ kpiOverview: kpi, drafts, insights, scheduledPosts, lastSync, now });

          expect(overview.kpiOverview).toBe(kpi);
          expect(Array.isArray(overview.approvalQueue)).toBe(true);
          expect(Array.isArray(overview.upcomingPosts)).toBe(true);
          expect(Array.isArray(overview.alertSection)).toBe(true);
          expect(overview.dataSyncStatus).toBeDefined();
          expect(overview.dataSyncStatus).toHaveProperty('lastSyncTime');
          expect(overview.dataSyncStatus).toHaveProperty('current');
          expect(overview.dataSyncStatus).toHaveProperty('warning');
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: lead-management-dashboard, Property 29: notifications composition
  it('Property 29: notifications are exactly token-expiry ∪ publish-failure ∪ insights-pending', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ platform: platArb, reason: fc.string({ maxLength: 8 }) }), { maxLength: 6 }),
        fc.array(fc.record({ status: contentStatusArb }), { maxLength: 12 }),
        fc.array(fc.record({ insightStatus: insightStatusArb }), { maxLength: 12 }),
        (warnSpecs, postSpecs, insightSpecs) => {
          const warnings: TokenExpiryWarning[] = warnSpecs.map((w) => ({ platform: w.platform, reason: w.reason }));
          const failedPosts: ScheduledPostLike[] = postSpecs.map((p, i) => ({
            id: `P${i}`,
            platform: 'facebook',
            status: p.status,
            scheduledPublishTime: dayIso(i),
            title: 't',
            failureReason: 'boom',
          }));
          const pendingInsights: InsightLike[] = insightSpecs.map((s, i) => ({
            id: `I${i}`,
            insightStatus: s.insightStatus,
            title: 't',
            createdAt: dayIso(i),
          }));

          const notes = buildNotifications(warnings, failedPosts, pendingInsights);
          const token = notes.filter((n) => n.kind === 'TOKEN_EXPIRY');
          const publish = notes.filter((n) => n.kind === 'PUBLISH_FAILURE');
          const pending = notes.filter((n) => n.kind === 'INSIGHTS_PENDING');

          expect(token.length).toBe(warnings.length);
          expect(new Set(publish.map((n) => n.ref))).toEqual(new Set(failedPosts.filter((p) => p.status === 'FAILED').map((p) => p.id)));
          expect(new Set(pending.map((n) => n.ref))).toEqual(
            new Set(pendingInsights.filter((s) => s.insightStatus === 'PENDING_REVIEW').map((s) => s.id)),
          );
          expect(notes.length).toBe(token.length + publish.length + pending.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
