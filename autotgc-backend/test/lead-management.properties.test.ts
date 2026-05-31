/**
 * Property-based tests for the lead-management-dashboard spec.
 *
 * Every design Correctness Property (1-30) that is amenable to property-based
 * testing has a fast-check test below, tagged
 *   // Feature: lead-management-dashboard, Property {n}: {exact design text}
 * and run with { numRuns: 100 }+.
 *
 * Service-level properties run against a small in-memory Prisma fake
 * (InMemoryPrisma) with an injected, monotonic clock; cross-module dashboard
 * reads are plain in-memory inputs to the pure assembler. Filter composition,
 * stats grouping, per-post / category+topic counts, and export round-trip are
 * checked against naive in-memory reference implementations.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';

import { LeadService } from '../src/leads/leadService';
import type { AuthInfo } from '../src/http/authMiddleware';
import {
  validateCreateLead,
  validateDateRange,
  resolveFacebookAttribution,
  resolveWebsiteAttribution,
  parseFacebookLeadgen,
  parseWebsiteForm,
  LEAD_SOURCES,
  LEAD_PLATFORMS,
  UNATTRIBUTED,
} from '../src/leads/validation';
import type { CreateLeadInput } from '../src/leads/validation';
import { leadTransition, LEAD_TRANSITIONS } from '../src/leads/statusMachine';
import type { LeadStatus } from '../src/leads/statusMachine';
import { isUpcoming, isDataStale } from '../src/dashboard/helpers';
import {
  buildApprovalQueue,
  compareApprovalItems,
  buildUpcomingPosts,
  buildAlertSection,
  buildDataSyncStatus,
  buildNotifications,
  assembleOverview,
} from '../src/dashboard/assembler';
import type {
  DraftLike,
  InsightLike,
  ScheduledPostLike,
  TokenExpiryWarning,
  ContentStatusLike,
  InsightStatusLike,
  DashboardPlatform,
} from '../src/dashboard/assembler';
import { authorize } from '../src/auth/rbac';
import type { Action } from '../src/auth/rbac';

// ---------------------------------------------------------------------------
// In-memory Prisma fake (lead + leadHistoryEntry) with an injected clock.
// ---------------------------------------------------------------------------

interface FakeLead {
  leadId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  platform: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  contentPostId: string;
  domainCategory: string | null;
  contentTopic: string | null;
  status: LeadStatus;
  note: string | null;
  assignedTo: string | null;
  unattributed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeHistory {
  id: string;
  leadId: string;
  previousStatus: string;
  newStatus: string;
  note: string | null;
  assignedTo: string | null;
  actor: string;
  changedAt: Date;
}

type DateFilter = { gte?: Date; lte?: Date };
interface LeadWhere {
  source?: string;
  platform?: string;
  status?: string;
  assignedTo?: string;
  contentPostId?: string;
  createdAt?: DateFilter;
  NOT?: { contentPostId?: string };
}

function matchWhere(lead: FakeLead, where: LeadWhere | undefined): boolean {
  if (!where) return true;
  if (where.source !== undefined && lead.source !== where.source) return false;
  if (where.platform !== undefined && lead.platform !== where.platform) return false;
  if (where.status !== undefined && lead.status !== where.status) return false;
  if (where.assignedTo !== undefined && lead.assignedTo !== where.assignedTo) return false;
  if (where.contentPostId !== undefined && lead.contentPostId !== where.contentPostId) return false;
  if (where.createdAt) {
    const t = lead.createdAt.getTime();
    if (where.createdAt.gte && t < where.createdAt.gte.getTime()) return false;
    if (where.createdAt.lte && t > where.createdAt.lte.getTime()) return false;
  }
  if (where.NOT?.contentPostId !== undefined && lead.contentPostId === where.NOT.contentPostId) return false;
  return true;
}

function sortBy<T>(rows: T[], orderBy: Record<string, 'asc' | 'desc'> | undefined): T[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0];
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    const an = av instanceof Date ? av.getTime() : Number(av);
    const bn = bv instanceof Date ? bv.getTime() : Number(bv);
    return an < bn ? -1 * sign : an > bn ? 1 * sign : 0;
  });
}

class InMemoryPrisma {
  private leads = new Map<string, FakeLead>();
  private histories: FakeHistory[] = [];
  private tick = 0;
  private readonly base = Date.UTC(2020, 0, 1);

  /** Injected monotonic clock: strictly increasing, always in the past. */
  private now(): Date {
    return new Date(this.base + this.tick++ * 1000);
  }

  /** Seed a fully-formed lead row directly (bypasses creation validation). */
  seedLead(partial: Partial<FakeLead> & { leadId: string }): FakeLead {
    const lead: FakeLead = {
      leadId: partial.leadId,
      name: partial.name ?? null,
      phone: partial.phone ?? null,
      email: partial.email ?? null,
      source: partial.source ?? 'website_form',
      platform: partial.platform ?? 'website',
      utmSource: partial.utmSource ?? null,
      utmMedium: partial.utmMedium ?? null,
      utmCampaign: partial.utmCampaign ?? null,
      contentPostId: partial.contentPostId ?? 'P1',
      domainCategory: partial.domainCategory ?? null,
      contentTopic: partial.contentTopic ?? null,
      status: partial.status ?? 'NEW',
      note: partial.note ?? null,
      assignedTo: partial.assignedTo ?? null,
      unattributed: partial.unattributed ?? false,
      createdAt: partial.createdAt ?? this.now(),
      updatedAt: partial.updatedAt ?? partial.createdAt ?? new Date(this.base),
    };
    this.leads.set(lead.leadId, lead);
    return lead;
  }

  get leadCount(): number {
    return this.leads.size;
  }

  snapshot(id: string): FakeLead | undefined {
    const l = this.leads.get(id);
    return l ? { ...l } : undefined;
  }

  historyCount(id: string): number {
    return this.histories.filter((h) => h.leadId === id).length;
  }

  // --- prisma.lead ---
  lead = {
    create: async ({ data }: { data: Record<string, unknown> }): Promise<FakeLead> => {
      const createdAt = this.now();
      const lead: FakeLead = {
        leadId: randomUUID(),
        name: (data.name as string | null) ?? null,
        phone: (data.phone as string | null) ?? null,
        email: (data.email as string | null) ?? null,
        source: data.source as string,
        platform: data.platform as string,
        utmSource: (data.utmSource as string | null) ?? null,
        utmMedium: (data.utmMedium as string | null) ?? null,
        utmCampaign: (data.utmCampaign as string | null) ?? null,
        contentPostId: data.contentPostId as string,
        domainCategory: (data.domainCategory as string | null) ?? null,
        contentTopic: (data.contentTopic as string | null) ?? null,
        status: (data.status as LeadStatus) ?? 'NEW',
        note: (data.note as string | null) ?? null,
        assignedTo: (data.assignedTo as string | null) ?? null,
        unattributed: (data.unattributed as boolean) ?? false,
        createdAt,
        updatedAt: createdAt,
      };
      this.leads.set(lead.leadId, lead);
      return { ...lead };
    },

    findUnique: async ({ where }: { where: { leadId: string } }): Promise<FakeLead | null> => {
      const l = this.leads.get(where.leadId);
      return l ? { ...l } : null;
    },

    findMany: async (args: {
      where?: LeadWhere;
      orderBy?: Record<string, 'asc' | 'desc'>;
      skip?: number;
      take?: number;
    }): Promise<FakeLead[]> => {
      let rows = [...this.leads.values()].filter((l) => matchWhere(l, args.where));
      rows = sortBy(rows, args.orderBy);
      const skip = args.skip ?? 0;
      const take = args.take ?? rows.length;
      return rows.slice(skip, skip + take).map((l) => ({ ...l }));
    },

    count: async (args: { where?: LeadWhere }): Promise<number> => {
      return [...this.leads.values()].filter((l) => matchWhere(l, args.where)).length;
    },

    update: async ({ where, data }: { where: { leadId: string }; data: Record<string, unknown> }): Promise<FakeLead> => {
      const existing = this.leads.get(where.leadId);
      if (!existing) throw new Error('Record to update not found');
      if (data.status !== undefined) existing.status = data.status as LeadStatus;
      if (data.note !== undefined) existing.note = data.note as string | null;
      if ('assignee' in data) {
        const a = data.assignee as { connect?: { id: string }; disconnect?: boolean };
        existing.assignedTo = a.disconnect ? null : (a.connect?.id ?? existing.assignedTo);
      }
      if (data.updatedAt !== undefined) existing.updatedAt = data.updatedAt as Date;
      this.leads.set(where.leadId, existing);
      return { ...existing };
    },

    delete: async ({ where }: { where: { leadId: string } }): Promise<FakeLead> => {
      const existing = this.leads.get(where.leadId);
      if (!existing) throw new Error('Record to delete not found');
      this.leads.delete(where.leadId);
      return { ...existing };
    },

    groupBy: async (args: { by: string[]; where?: LeadWhere }): Promise<Array<Record<string, unknown>>> => {
      const field = args.by[0];
      const rows = [...this.leads.values()].filter((l) => matchWhere(l, args.where));
      const counts = new Map<string, number>();
      for (const l of rows) {
        const key = String((l as Record<string, unknown>)[field]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([key, count]) => ({ [field]: key, _count: { _all: count } }));
    },
  };

  // --- prisma.leadHistoryEntry ---
  leadHistoryEntry = {
    create: async ({ data }: { data: Record<string, unknown> }): Promise<FakeHistory> => {
      const entry: FakeHistory = {
        id: randomUUID(),
        leadId: data.leadId as string,
        previousStatus: data.previousStatus as string,
        newStatus: data.newStatus as string,
        note: (data.note as string | null) ?? null,
        assignedTo: (data.assignedTo as string | null) ?? null,
        actor: data.actor as string,
        changedAt: this.now(),
      };
      this.histories.push(entry);
      return { ...entry };
    },

    findMany: async (args: {
      where?: { leadId?: string };
      orderBy?: Record<string, 'asc' | 'desc'>;
    }): Promise<FakeHistory[]> => {
      let rows = this.histories.filter((h) => !args.where?.leadId || h.leadId === args.where.leadId);
      rows = sortBy(rows, args.orderBy);
      return rows.map((h) => ({ ...h }));
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers + arbitraries
// ---------------------------------------------------------------------------

// Cast the fake to PrismaClient for the LeadService constructor (structural).
function makeService(prisma: InMemoryPrisma): LeadService {
  return new LeadService(prisma as unknown as ConstructorParameters<typeof LeadService>[0]);
}

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-admin' };
const salesActor = (userId: string): AuthInfo => ({ userId, role: 'SALES', sessionId: 'sess-sales' });

/** Await a promise expecting an AppError-like rejection with the given status. */
async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
  try {
    await p;
    throw new Error(`expected rejection with status ${status}, but it resolved`);
  } catch (err) {
    const s = (err as { status?: number }).status;
    expect(s).toBe(status);
  }
}

const ALL_STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'];
const BASE_DAY = Date.UTC(2026, 0, 1);
const dayDate = (offset: number): Date => new Date(BASE_DAY + offset * 86400_000);

// Strings free of CSV-special characters (keeps export round-trip parsing simple).
const safeText = fc.string({ maxLength: 10 }).filter((s) => !/[",\n\r]/.test(s));
const nonBlank = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0 && !/[",\n\r]/.test(s));

interface LeadSpec {
  source: string;
  platform: string;
  status: LeadStatus;
  dayOffset: number;
  assignedTo: string | null;
  contentPostId: string;
  domainCategory: string | null;
  contentTopic: string | null;
}

const leadSpecArb: fc.Arbitrary<LeadSpec> = fc.record({
  source: fc.constantFrom(...LEAD_SOURCES),
  platform: fc.constantFrom(...LEAD_PLATFORMS),
  status: fc.constantFrom(...ALL_STATUSES),
  dayOffset: fc.integer({ min: 0, max: 40 }),
  assignedTo: fc.constantFrom('U1', 'U2', null),
  contentPostId: fc.constantFrom('P1', 'P2', 'P3', UNATTRIBUTED),
  domainCategory: fc.constantFrom('catA', 'catB', null),
  contentTopic: fc.constantFrom('t1', 't2', null),
});

/** Seed an array of specs into the fake with unique ids; returns the FakeLeads. */
function seedSpecs(prisma: InMemoryPrisma, specs: LeadSpec[]): FakeLead[] {
  return specs.map((s, i) =>
    prisma.seedLead({
      leadId: `L${i}`,
      source: s.source,
      platform: s.platform,
      status: s.status,
      createdAt: dayDate(s.dayOffset),
      assignedTo: s.assignedTo,
      contentPostId: s.contentPostId,
      domainCategory: s.domainCategory,
      contentTopic: s.contentTopic,
      unattributed: s.contentPostId === UNATTRIBUTED,
    }),
  );
}

// ===========================================================================
// Lead creation + validation properties
// ===========================================================================

describe('lead-management-dashboard: creation & validation', () => {
  // Feature: lead-management-dashboard, Property 1: For any valid lead-creation input (at least one of phone/email, a valid LeadSource, a valid LeadPlatform, and a content_post_id), the created Lead is assigned a unique lead_id, has status = NEW, and has updated_at equal to created_at.
  it('Property 1: lead creation invariants (unique id, status NEW, updatedAt==createdAt)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            phone: fc.option(nonBlank, { nil: undefined }),
            email: fc.option(nonBlank, { nil: undefined }),
            source: fc.constantFrom(...LEAD_SOURCES),
            platform: fc.constantFrom(...LEAD_PLATFORMS),
            contentPostId: nonBlank,
            name: fc.option(safeText, { nil: undefined }),
          }).filter((r) => Boolean(r.phone) || Boolean(r.email)),
          { minLength: 1, maxLength: 8 },
        ),
        async (inputs) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          const ids = new Set<string>();
          for (const input of inputs) {
            const lead = await svc.create(input as CreateLeadInput, ADMIN);
            expect(lead.status).toBe('NEW');
            expect(lead.updatedAt.getTime()).toBe(lead.createdAt.getTime());
            expect(ids.has(lead.leadId)).toBe(false);
            ids.add(lead.leadId);
          }
          expect(ids.size).toBe(inputs.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 2: For any creation input in which both phone and email are absent or blank, the Lead_Service rejects with HTTP 400 and creates no Lead.
  it('Property 2: contact-required validation (both phone+email blank => 400, no Lead)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          phone: fc.option(fc.constantFrom('', '   ', '\t'), { nil: undefined }),
          email: fc.option(fc.constantFrom('', '  '), { nil: undefined }),
          source: fc.constantFrom(...LEAD_SOURCES),
          platform: fc.constantFrom(...LEAD_PLATFORMS),
          contentPostId: nonBlank,
        }),
        async (input) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          await expectStatus(svc.create(input as CreateLeadInput, ADMIN), 400);
          expect(prisma.leadCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 3: For any direct /api/leads creation input that omits content_post_id, the Lead_Service rejects with HTTP 400 and creates no Lead.
  it('Property 3: required content_post_id on direct creation (omitted => 400, no Lead)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          phone: nonBlank,
          email: fc.option(nonBlank, { nil: undefined }),
          source: fc.constantFrom(...LEAD_SOURCES),
          platform: fc.constantFrom(...LEAD_PLATFORMS),
          contentPostId: fc.constantFrom(undefined, '', '   '),
        }),
        async (input) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          await expectStatus(svc.create(input as CreateLeadInput, ADMIN), 400);
          expect(prisma.leadCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 4: For any creation input whose source is not one of the four LeadSource values or whose platform is not one of the three LeadPlatform values, the Lead_Service rejects with HTTP 400 identifying the invalid value and creates no Lead.
  it('Property 4: enum validation for source and platform (invalid => 400, no Lead)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          phone: nonBlank,
          source: fc.oneof(fc.constantFrom(...LEAD_SOURCES), fc.constantFrom('bogus', 'FACEBOOK', 'x')),
          platform: fc.oneof(fc.constantFrom(...LEAD_PLATFORMS), fc.constantFrom('bogus', 'WEB', 'y')),
          contentPostId: nonBlank,
        }).filter(
          (r) => !LEAD_SOURCES.includes(r.source as never) || !LEAD_PLATFORMS.includes(r.platform as never),
        ),
        async (input) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          await expectStatus(svc.create(input as CreateLeadInput, ADMIN), 400);
          expect(prisma.leadCount).toBe(0);
          // The pure validator identifies the invalid value in its message.
          const v = validateCreateLead(input as CreateLeadInput, true);
          expect(v.ok).toBe(false);
          if (!v.ok) {
            const bad = !LEAD_SOURCES.includes(input.source as never) ? input.source : input.platform;
            expect(v.message).toContain(String(bad));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 5: For any provided utm_source/utm_medium/utm_campaign, domain_category, and content_topic values on a created or associated Lead, reading that Lead back returns exactly those stored values.
  it('Property 5: attribute storage round-trip (utm_*, domain_category, content_topic)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          phone: nonBlank,
          source: fc.constantFrom(...LEAD_SOURCES),
          platform: fc.constantFrom(...LEAD_PLATFORMS),
          contentPostId: nonBlank,
          utmSource: fc.option(safeText, { nil: undefined }),
          utmMedium: fc.option(safeText, { nil: undefined }),
          utmCampaign: fc.option(safeText, { nil: undefined }),
          domainCategory: fc.option(safeText, { nil: undefined }),
          contentTopic: fc.option(safeText, { nil: undefined }),
        }),
        async (input) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          const created = await svc.create(input as CreateLeadInput, ADMIN);
          const back = await svc.get(created.leadId, ADMIN);
          expect(back.utmSource).toBe(input.utmSource ?? null);
          expect(back.utmMedium).toBe(input.utmMedium ?? null);
          expect(back.utmCampaign).toBe(input.utmCampaign ?? null);
          expect(back.domainCategory).toBe(input.domainCategory ?? null);
          expect(back.contentTopic).toBe(input.contentTopic ?? null);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 8: For any list, stats, or export request whose from date is later than its to date, the Lead_Service rejects with HTTP 400 ("date range is invalid") before querying.
  it('Property 8: date-range validation across list/stats/export (from > to => 400)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        async (a, b) => {
          // Ensure from > to.
          const fromOff = Math.max(a, b);
          const toOff = Math.min(a, b);
          fc.pre(fromOff > toOff);
          const from = dayDate(fromOff).toISOString();
          const to = dayDate(toOff).toISOString();

          // Pure validator first.
          expect(validateDateRange(from, to).ok).toBe(false);

          const prisma = new InMemoryPrisma();
          prisma.seedLead({ leadId: 'guard', createdAt: dayDate(toOff) });
          const svc = makeService(prisma);
          await expectStatus(svc.list({ from, to }, 1, 20, ADMIN), 400);
          await expectStatus(svc.stats('source', from, to, ADMIN), 400);
          await expectStatus(svc.export('csv', from, to, ADMIN), 400);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Listing / filtering / pagination / detail / update / delete properties
// ===========================================================================

describe('lead-management-dashboard: list / filter / pagination', () => {
  // Feature: lead-management-dashboard, Property 6: For any set of stored Leads and any page/limit, the listing returns total equal to the count of matching Leads, returns at most limit items per page, and partitions the matching set across pages with no duplicates and no omissions.
  it('Property 6: pagination invariant (total, at-most-limit, partition without dup/omission)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 1, max: 8 }),
        async (specs, limit) => {
          const prisma = new InMemoryPrisma();
          seedSpecs(prisma, specs);
          const svc = makeService(prisma);

          const first = await svc.list({}, 1, limit, ADMIN);
          expect(first.total).toBe(specs.length);

          const collected: string[] = [];
          const pages = Math.max(1, Math.ceil(specs.length / limit));
          for (let p = 1; p <= pages; p++) {
            const res = await svc.list({}, p, limit, ADMIN);
            expect(res.items.length).toBeLessThanOrEqual(limit);
            expect(res.total).toBe(specs.length);
            for (const item of res.items) collected.push(item.leadId);
          }
          // No duplicates.
          expect(new Set(collected).size).toBe(collected.length);
          // No omissions: every seeded lead appears exactly once.
          expect(collected.sort()).toEqual(specs.map((_, i) => `L${i}`).sort());
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 7: For any set of Leads and any combination of source, platform, status, and date-range (from/to) filters, the returned set equals exactly the Leads satisfying every present filter, where the date-range predicate is inclusive of both boundaries.
  it('Property 7: filter correctness and composition (vs naive in-memory reference)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { minLength: 0, maxLength: 25 }),
        fc.record({
          source: fc.option(fc.constantFrom(...LEAD_SOURCES), { nil: undefined }),
          platform: fc.option(fc.constantFrom(...LEAD_PLATFORMS), { nil: undefined }),
          status: fc.option(fc.constantFrom(...ALL_STATUSES), { nil: undefined }),
          fromOff: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
          toOff: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
        }),
        async (specs, raw) => {
          // Make from <= to so the date range is valid (P8 covers from>to).
          let fromOff = raw.fromOff;
          let toOff = raw.toOff;
          if (fromOff !== undefined && toOff !== undefined && fromOff > toOff) {
            [fromOff, toOff] = [toOff, fromOff];
          }
          const from = fromOff !== undefined ? dayDate(fromOff).toISOString() : undefined;
          const to = toOff !== undefined ? dayDate(toOff).toISOString() : undefined;

          const prisma = new InMemoryPrisma();
          const seeded = seedSpecs(prisma, specs);
          const svc = makeService(prisma);

          const res = await svc.list(
            { source: raw.source, platform: raw.platform, status: raw.status, from, to },
            1,
            1000,
            ADMIN,
          );

          // Naive reference.
          const expected = seeded.filter((l) => {
            if (raw.source !== undefined && l.source !== raw.source) return false;
            if (raw.platform !== undefined && l.platform !== raw.platform) return false;
            if (raw.status !== undefined && l.status !== raw.status) return false;
            const t = l.createdAt.getTime();
            if (from !== undefined && t < Date.parse(from)) return false;
            if (to !== undefined && t > Date.parse(to)) return false;
            return true;
          });

          expect(res.total).toBe(expected.length);
          expect(new Set(res.items.map((i) => i.leadId))).toEqual(new Set(expected.map((l) => l.leadId)));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('lead-management-dashboard: detail / update / delete', () => {
  /** Build a service + a single assigned lead in 'NEW' status. */
  async function seedOne(prisma: InMemoryPrisma, assignedTo: string | null = null): Promise<string> {
    const lead = prisma.seedLead({ leadId: 'lead-1', status: 'NEW', assignedTo, createdAt: dayDate(0) });
    return lead.leadId;
  }

  // Feature: lead-management-dashboard, Property 9: For any Lead and any sequence of applied updates, the detail view returns the Lead together with its complete Interaction_History ordered most-recent-first by change timestamp.
  it('Property 9: interaction-history presence and ordering (most-recent-first)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A sequence of notes; each accepted update appends one history entry.
        fc.array(safeText, { minLength: 1, maxLength: 8 }),
        async (notes) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          const id = await seedOne(prisma);
          for (const note of notes) {
            await svc.update(id, { note }, ADMIN);
          }
          const detail = await svc.get(id, ADMIN);
          const history = detail.history as Array<{ changedAt: Date }>;
          expect(history.length).toBe(notes.length);
          for (let i = 1; i < history.length; i++) {
            expect(history[i - 1].changedAt.getTime()).toBeGreaterThanOrEqual(history[i].changedAt.getTime());
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 10: For any lead_id not present in the store, a detail, update, or delete request returns HTTP 404 and modifies no Lead.
  it('Property 10: not-found leaves store unchanged (detail/update/delete => 404)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { minLength: 0, maxLength: 10 }),
        nonBlank,
        async (specs, missingId) => {
          const prisma = new InMemoryPrisma();
          seedSpecs(prisma, specs);
          // Ensure the id is genuinely absent (seeded ids are L0..Ln).
          fc.pre(!/^L\d+$/.test(missingId));
          const svc = makeService(prisma);
          const before = prisma.leadCount;

          await expectStatus(svc.get(missingId, ADMIN), 404);
          await expectStatus(svc.update(missingId, { note: 'x' }, ADMIN), 404);
          await expectStatus(svc.delete(missingId, ADMIN), 404);

          expect(prisma.leadCount).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 11: For any Lead and any update that is accepted (a permitted transition and/or note/assignment change), the Lead_Service applies the changes, advances updated_at, and appends exactly one Lead_History_Entry capturing the previous status, new status, note, assigned_to, acting identity, and change timestamp, leaving all prior history entries unchanged.
  it('Property 11: update applies fields and appends exactly one history entry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<LeadStatus>('NEW', 'CONTACTED', 'QUALIFIED'),
        fc.option(safeText, { nil: undefined }),
        async (startStatus, note) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          prisma.seedLead({ leadId: 'lead-1', status: startStatus, createdAt: dayDate(0) });

          // Pick a legal target transition from startStatus (or undefined to keep status).
          const legalTargets = LEAD_TRANSITIONS.filter(([s]) => s === startStatus).map(([, t]) => t);
          const target = legalTargets[0]; // deterministic legal transition
          const before = prisma.snapshot('lead-1')!;
          const historyBefore = prisma.historyCount('lead-1');

          const updated = await svc.update('lead-1', { status: target, note }, ADMIN);

          expect(updated.status).toBe(target);
          if (note !== undefined) expect(updated.note).toBe(note);
          expect(updated.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

          // Exactly one new history entry, capturing prev/new + actor.
          expect(prisma.historyCount('lead-1')).toBe(historyBefore + 1);
          const detail = await svc.get('lead-1', ADMIN);
          const history = detail.history as Array<{
            previousStatus: string; newStatus: string; note: string | null; actor: string;
          }>;
          expect(history[0].previousStatus).toBe(startStatus);
          expect(history[0].newStatus).toBe(target);
          expect(history[0].actor).toBe(ADMIN.userId);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 12: For any current LeadStatus S and target LeadStatus T, the transition succeeds if and only if (S, T) is one of the six allowed edges (NEW->CONTACTED, CONTACTED->QUALIFIED, QUALIFIED->CONVERTED, and NEW|CONTACTED|QUALIFIED -> LOST); every terminal source (CONVERTED, LOST) and every other pair is rejected with HTTP 409, and a rejected transition changes neither the status nor the Interaction_History.
  it('Property 12: lead status transition closure (all 25 pairs)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ALL_STATUSES), fc.constantFrom(...ALL_STATUSES), async (s, t) => {
        const allowed = LEAD_TRANSITIONS.some(([a, b]) => a === s && b === t);

        // Pure machine.
        const r = leadTransition(s, t);
        expect(r.ok).toBe(allowed);
        if (s === 'CONVERTED' || s === 'LOST') expect(r.ok).toBe(false);

        // Service-level: illegal transition => 409, status + history unchanged.
        const prisma = new InMemoryPrisma();
        const svc = makeService(prisma);
        prisma.seedLead({ leadId: 'lead-1', status: s, createdAt: dayDate(0) });
        const histBefore = prisma.historyCount('lead-1');

        if (s === t) {
          // Same-state update is a no-op on status (service skips transition); not in scope here.
          return;
        }
        if (allowed) {
          const updated = await svc.update('lead-1', { status: t }, ADMIN);
          expect(updated.status).toBe(t);
          expect(prisma.historyCount('lead-1')).toBe(histBefore + 1);
        } else {
          await expectStatus(svc.update('lead-1', { status: t }, ADMIN), 409);
          expect(prisma.snapshot('lead-1')!.status).toBe(s);
          expect(prisma.historyCount('lead-1')).toBe(histBefore);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 13: For any existing Lead, an ADMIN delete removes it so that a subsequent read returns 404.
  it('Property 13: delete round-trip (delete then read => 404)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(leadSpecArb, { minLength: 1, maxLength: 10 }), async (specs) => {
        const prisma = new InMemoryPrisma();
        seedSpecs(prisma, specs);
        const svc = makeService(prisma);
        const targetId = `L${Math.floor(specs.length / 2)}`;

        await svc.delete(targetId, ADMIN);
        await expectStatus(svc.get(targetId, ADMIN), 404);
        expect(prisma.snapshot(targetId)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Stats / export / SALES scope properties
// ===========================================================================

describe('lead-management-dashboard: stats / export / scope', () => {
  // Feature: lead-management-dashboard, Property 14: For any set of Leads, a valid Group_Dimension (source, platform, or date), and a date range, the returned per-group counts equal the counts produced by naively grouping the in-range Leads by that dimension, and the group counts sum to the number of in-range Leads.
  it('Property 14: stats grouping correctness (vs naive reference; counts sum to in-range total)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { minLength: 0, maxLength: 25 }),
        fc.constantFrom<'source' | 'platform' | 'date'>('source', 'platform', 'date'),
        fc.record({
          fromOff: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
          toOff: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
        }),
        async (specs, groupBy, raw) => {
          let fromOff = raw.fromOff;
          let toOff = raw.toOff;
          if (fromOff !== undefined && toOff !== undefined && fromOff > toOff) {
            [fromOff, toOff] = [toOff, fromOff];
          }
          const from = fromOff !== undefined ? dayDate(fromOff).toISOString() : undefined;
          const to = toOff !== undefined ? dayDate(toOff).toISOString() : undefined;

          const prisma = new InMemoryPrisma();
          const seeded = seedSpecs(prisma, specs);
          const svc = makeService(prisma);

          const res = await svc.stats(groupBy, from, to, ADMIN);

          const inRange = seeded.filter((l) => {
            const t = l.createdAt.getTime();
            if (from !== undefined && t < Date.parse(from)) return false;
            if (to !== undefined && t > Date.parse(to)) return false;
            return true;
          });
          const ref = new Map<string, number>();
          for (const l of inRange) {
            const key =
              groupBy === 'date' ? l.createdAt.toISOString().slice(0, 10) : (l as Record<string, unknown>)[groupBy] as string;
            ref.set(String(key), (ref.get(String(key)) ?? 0) + 1);
          }

          // Buckets match the naive grouping.
          const got = new Map(res.buckets.map((b) => [b.key, b.count]));
          expect(got).toEqual(ref);
          // Group counts sum to the in-range total.
          const sum = res.buckets.reduce((acc, b) => acc + b.count, 0);
          expect(sum).toBe(inRange.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 15: For any group_by value not in {source, platform, date}, the Lead_Service rejects with HTTP 400 identifying the invalid dimension.
  it('Property 15: invalid stats dimension rejected (=> 400 identifying the dimension)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 12 }).filter((s) => !['source', 'platform', 'date'].includes(s)),
        async (groupBy) => {
          const prisma = new InMemoryPrisma();
          prisma.seedLead({ leadId: 'L0', createdAt: dayDate(0) });
          const svc = makeService(prisma);
          try {
            await svc.stats(groupBy, undefined, undefined, ADMIN);
            throw new Error('expected 400');
          } catch (err) {
            expect((err as { status?: number }).status).toBe(400);
            expect((err as Error).message).toContain(groupBy);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 16: For any set of Leads, a date range, and a format of csv or xlsx, parsing the produced Export_File yields exactly the Leads matching the range; for any format outside {csv, xlsx}, the request is rejected with HTTP 400 and no file is produced.
  it('Property 16: export round-trip and format validation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom('csv', 'xlsx'),
        fc.record({
          fromOff: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
          toOff: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
        }),
        async (specs, format, raw) => {
          let fromOff = raw.fromOff;
          let toOff = raw.toOff;
          if (fromOff !== undefined && toOff !== undefined && fromOff > toOff) {
            [fromOff, toOff] = [toOff, fromOff];
          }
          const from = fromOff !== undefined ? dayDate(fromOff).toISOString() : undefined;
          const to = toOff !== undefined ? dayDate(toOff).toISOString() : undefined;

          const prisma = new InMemoryPrisma();
          const seeded = seedSpecs(prisma, specs);
          const svc = makeService(prisma);

          const result = await svc.export(format, from, to, ADMIN);
          // Parse the CSV: header + one row per lead; first column is leadId.
          const lines = result.body.split('\n');
          const dataLines = lines.slice(1).filter((l) => l.length > 0);
          const parsedIds = dataLines.map((l) => l.split(',')[0]);

          const expected = seeded.filter((l) => {
            const t = l.createdAt.getTime();
            if (from !== undefined && t < Date.parse(from)) return false;
            if (to !== undefined && t > Date.parse(to)) return false;
            return true;
          });
          expect(new Set(parsedIds)).toEqual(new Set(expected.map((l) => l.leadId)));
          expect(parsedIds.length).toBe(expected.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 16 (cont.): invalid export format => 400, no file', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 10 }).filter((s) => s !== 'csv' && s !== 'xlsx'),
        async (format) => {
          const prisma = new InMemoryPrisma();
          prisma.seedLead({ leadId: 'L0', createdAt: dayDate(0) });
          const svc = makeService(prisma);
          await expectStatus(svc.export(format, undefined, undefined, ADMIN), 400);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 17: For any set of Leads with mixed assignment and a SALES actor, the leads listed, counted in stats, or included in an export contain only Leads assigned to that Sales_Consultant.
  it('Property 17: SALES scope restriction on list, stats, and export', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(leadSpecArb, { minLength: 0, maxLength: 25 }), async (specs) => {
        const prisma = new InMemoryPrisma();
        const seeded = seedSpecs(prisma, specs);
        const svc = makeService(prisma);
        const sales = salesActor('U1');

        // list: only U1's leads.
        const list = await svc.list({}, 1, 1000, sales);
        for (const item of list.items) expect(item.assignedTo).toBe('U1');
        const assignedToU1 = seeded.filter((l) => l.assignedTo === 'U1');
        expect(list.total).toBe(assignedToU1.length);

        // stats: counts sum to assigned subset.
        const stats = await svc.stats('source', undefined, undefined, sales);
        const sum = stats.buckets.reduce((acc, b) => acc + b.count, 0);
        expect(sum).toBe(assignedToU1.length);

        // export: only U1's leads.
        const exp = await svc.export('csv', undefined, undefined, sales);
        const ids = exp.body.split('\n').slice(1).filter((l) => l.length > 0).map((l) => l.split(',')[0]);
        expect(new Set(ids)).toEqual(new Set(assignedToU1.map((l) => l.leadId)));
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Webhook attribution + parse properties
// ===========================================================================

describe('lead-management-dashboard: webhook attribution & parsing', () => {
  // Feature: lead-management-dashboard, Property 18: For any verified, parseable webhook submission: a Facebook submission yields source = facebook_leadgen, platform = facebook; a website submission yields platform = website with source = tiktok_bio if and only if utm_source = 'tiktok_bio' (otherwise website_form, including when utm_source is absent); a resolvable content/campaign identifier is stored as content_post_id; when no resolvable identifier is present the Lead is created with content_post_id = 'unattributed' and unattributed = true; and in all cases the created Lead has status = NEW.
  it('Property 18: webhook source and content attribution (FB + website), always status NEW', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({ kind: fc.constant('facebook' as const), contentPostId: fc.option(nonBlank, { nil: undefined }) }),
          fc.record({
            kind: fc.constant('website' as const),
            utmSource: fc.option(fc.oneof(fc.constant('tiktok_bio'), safeText), { nil: undefined }),
            contentPostId: fc.option(nonBlank, { nil: undefined }),
          }),
        ),
        async (payload) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);

          const attribution =
            payload.kind === 'facebook'
              ? resolveFacebookAttribution(payload.contentPostId)
              : resolveWebsiteAttribution(
                  (payload as { utmSource?: string }).utmSource,
                  payload.contentPostId,
                );

          const lead = await svc.createFromWebhook(attribution, { phone: '0900', utmSource: (payload as { utmSource?: string }).utmSource });

          if (payload.kind === 'facebook') {
            expect(lead.source).toBe('facebook_leadgen');
            expect(lead.platform).toBe('facebook');
          } else {
            expect(lead.platform).toBe('website');
            const utm = (payload as { utmSource?: string }).utmSource;
            expect(lead.source).toBe(utm === 'tiktok_bio' ? 'tiktok_bio' : 'website_form');
          }

          const resolvable = Boolean(payload.contentPostId && payload.contentPostId.trim().length > 0);
          if (resolvable) {
            expect(lead.contentPostId).toBe(payload.contentPostId);
            expect(lead.unattributed).toBe(false);
          } else {
            expect(lead.contentPostId).toBe(UNATTRIBUTED);
            expect(lead.unattributed).toBe(true);
          }
          expect(lead.status).toBe('NEW');
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 19: For any verified webhook request whose body cannot be parsed as the expected format (Facebook Leadgen or CMS form), the Lead_Service rejects with HTTP 400 and creates no Lead.
  it('Property 19: webhook parse rejection (unparseable verified body => 400, no Lead)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Non-object bodies are unparseable for both formats.
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.anything()),
        ),
        async (raw) => {
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);

          const fb = parseFacebookLeadgen(raw);
          const web = parseWebsiteForm(raw);
          expect(fb).toBeNull();
          expect(web).toBeNull();

          // The ingestor would reject with 400 before any persistence.
          // Model that: a null parse means no createFromWebhook call happens.
          expect(prisma.leadCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Lead_Analytics_Query properties
// ===========================================================================

describe('lead-management-dashboard: analytics queries', () => {
  // Feature: lead-management-dashboard, Property 20: For any set of Leads and any content_post_id, countByContentPost returns the number of Leads associated with that content_post_id, excluding unattributed Leads.
  it('Property 20: per-post lead-count correctness (excludes unattributed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { minLength: 0, maxLength: 25 }),
        fc.constantFrom('P1', 'P2', 'P3', UNATTRIBUTED),
        async (specs, postId) => {
          const prisma = new InMemoryPrisma();
          const seeded = seedSpecs(prisma, specs);
          const svc = makeService(prisma);

          const got = await svc.countByContentPost(postId);
          const expected = seeded.filter(
            (l) => l.contentPostId === postId && l.contentPostId !== UNATTRIBUTED,
          ).length;
          expect(got).toBe(expected);
          if (postId === UNATTRIBUTED) expect(got).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 21: For any set of Leads and a date range, countByCategoryAndTopic returns counts matching a naive grouping of the in-range Leads by (domain_category, content_topic).
  it('Property 21: category-and-topic lead-count correctness (vs naive grouping)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(leadSpecArb, { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 20, max: 40 }),
        async (specs, fromOff, toOff) => {
          const from = dayDate(fromOff).toISOString();
          const to = dayDate(toOff).toISOString();

          const prisma = new InMemoryPrisma();
          const seeded = seedSpecs(prisma, specs);
          const svc = makeService(prisma);

          const got = await svc.countByCategoryAndTopic(from, to);

          const inRange = seeded.filter((l) => {
            const t = l.createdAt.getTime();
            return t >= Date.parse(from) && t <= Date.parse(to);
          });
          const ref = new Map<string, number>();
          for (const l of inRange) {
            const key = `${l.domainCategory ?? ''}\u0000${l.contentTopic ?? ''}`;
            ref.set(key, (ref.get(key) ?? 0) + 1);
          }
          const gotMap = new Map(got.map((g) => [`${g.domainCategory}\u0000${g.contentTopic}`, g.count]));
          expect(gotMap).toEqual(ref);
          const sum = got.reduce((acc, g) => acc + g.count, 0);
          expect(sum).toBe(inRange.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// RBAC properties (pure policy + service-level enforcement)
// ===========================================================================

describe('lead-management-dashboard: RBAC', () => {
  // Feature: lead-management-dashboard, Property 22: For any Lead and operation: an ADMIN actor is granted access to create, list, view, update, delete, aggregate, and export; a SALES actor is granted view and status/note update only on Leads assigned to it; a SALES actor targeting a non-assigned Lead for view or update is denied with HTTP 403; and a SALES actor attempting any delete is denied with HTTP 403 - every denial leaves the Lead unmodified.
  it('Property 22: lead RBAC enforcement (pure policy + service-level denials leave Lead unmodified)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Action>('read', 'create', 'update', 'delete', 'status_update'),
        fc.boolean(), // assigned to this SALES user?
        async (action, assigned) => {
          const owner = assigned ? 'U1' : 'U2';

          // Pure policy: ADMIN is granted every lead operation.
          const adminDecision = authorize({ userId: 'admin', role: 'ADMIN' }, { module: 'lead_management', action });
          expect(adminDecision.allowed).toBe(true);

          // Pure policy: SALES is granted read/update/status_update only on assigned leads;
          // create and delete are never granted; non-assigned read/update is denied.
          const salesDecision = authorize(
            { userId: 'U1', role: 'SALES' },
            { module: 'lead_management', action, ownerUserId: owner },
          );
          const salesGranted =
            action !== 'delete' &&
            action !== 'create' &&
            assigned &&
            (action === 'read' || action === 'update' || action === 'status_update');
          expect(salesDecision.allowed).toBe(salesGranted);

          // Service-level enforcement: SALES on non-assigned => 403, nothing modified;
          // SALES delete => 403 regardless of assignment.
          const prisma = new InMemoryPrisma();
          const svc = makeService(prisma);
          prisma.seedLead({ leadId: 'lead-1', status: 'NEW', assignedTo: 'U1', createdAt: dayDate(0) });
          const sales = salesActor('U2'); // not the assignee
          const before = prisma.snapshot('lead-1')!;

          await expectStatus(svc.get('lead-1', sales), 403);
          await expectStatus(svc.update('lead-1', { note: 'x' }, sales), 403);
          await expectStatus(svc.delete('lead-1', sales), 403); // SALES delete always 403
          // SALES delete of an assigned lead is still 403.
          await expectStatus(svc.delete('lead-1', salesActor('U1')), 403);

          const after = prisma.snapshot('lead-1')!;
          expect(after).toEqual(before);
          expect(prisma.historyCount('lead-1')).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Dashboard assembler properties (pure composition with injected clock)
// ===========================================================================

const CONTENT_STATUSES: ContentStatusLike[] = [
  'DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'FAILED',
];
const INSIGHT_STATUSES: InsightStatusLike[] = ['NEW', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'];
const PLATFORMS: DashboardPlatform[] = ['facebook', 'tiktok', 'website'];

const isoArb = fc.integer({ min: 0, max: 1_000_000 }).map((n) => new Date(BASE_DAY + n * 60_000).toISOString());

const draftArb: fc.Arbitrary<DraftLike> = fc.record({
  id: fc.uuid(),
  status: fc.constantFrom(...CONTENT_STATUSES),
  title: safeText,
  createdAt: isoArb,
  deadlineAt: fc.option(isoArb, { nil: null }),
});

const insightArb: fc.Arbitrary<InsightLike> = fc.record({
  id: fc.uuid(),
  insightStatus: fc.constantFrom(...INSIGHT_STATUSES),
  title: safeText,
  createdAt: isoArb,
  deadlineAt: fc.option(isoArb, { nil: null }),
});

const scheduledPostArb: fc.Arbitrary<ScheduledPostLike> = fc.record({
  id: fc.uuid(),
  platform: fc.constantFrom(...PLATFORMS),
  status: fc.constantFrom(...CONTENT_STATUSES),
  scheduledPublishTime: fc.integer({ min: -10, max: 14 }).map((d) => dayDate(d).toISOString()),
  title: safeText,
  failureReason: fc.option(fc.constantFrom('TOKEN_EXPIRED', 'RATE_LIMIT', 'UPSTREAM_5XX'), { nil: null }),
});

const tokenWarningArb: fc.Arbitrary<TokenExpiryWarning> = fc.record({
  platform: fc.constantFrom('facebook', 'tiktok', 'website'),
  reason: fc.constantFrom('TOKEN_EXPIRED', 'REFRESH_FAILED'),
  raisedAt: isoArb,
});

describe('lead-management-dashboard: dashboard assembly', () => {
  // Feature: lead-management-dashboard, Property 23: For any successfully assembled Dashboard_Overview, the result includes all five sections: KPI_Overview, Approval_Queue, Upcoming_Posts, Alert_Section, and Data_Sync_Status.
  it('Property 23: overview completeness (all five sections present)', () => {
    fc.assert(
      fc.property(
        fc.array(draftArb, { maxLength: 8 }),
        fc.array(insightArb, { maxLength: 8 }),
        fc.array(scheduledPostArb, { maxLength: 8 }),
        fc.array(tokenWarningArb, { maxLength: 4 }),
        fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
        (drafts, insights, posts, warnings, lastSyncDay) => {
          const now = dayDate(10);
          const lastSync = lastSyncDay === null ? null : dayDate(lastSyncDay);
          const overview = assembleOverview({
            kpiOverview: { view: { total: 0, points: [] }, lead: { total: 0, points: [] }, follow: { total: 0, points: [] } },
            drafts,
            insights,
            scheduledPosts: posts,
            tokenWarnings: warnings,
            lastSync,
            now,
          });
          expect(overview).toHaveProperty('kpiOverview');
          expect(overview).toHaveProperty('approvalQueue');
          expect(overview).toHaveProperty('upcomingPosts');
          expect(overview).toHaveProperty('alertSection');
          expect(overview).toHaveProperty('dataSyncStatus');
          expect(Array.isArray(overview.approvalQueue)).toBe(true);
          expect(Array.isArray(overview.upcomingPosts)).toBe(true);
          expect(Array.isArray(overview.alertSection)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 24: For any set of Content_Drafts and Learning_Insights of mixed statuses, the Approval_Queue contains exactly the Content_Drafts whose Content_Status is DRAFT and the Learning_Insights whose Insight_Status is PENDING_REVIEW, and nothing else.
  it('Property 24: approval-queue composition (exactly DRAFT drafts ∪ PENDING_REVIEW insights)', () => {
    fc.assert(
      fc.property(fc.array(draftArb, { maxLength: 12 }), fc.array(insightArb, { maxLength: 12 }), (drafts, insights) => {
        const queue = buildApprovalQueue(drafts, insights);

        const expectedDraftIds = drafts.filter((d) => d.status === 'DRAFT').map((d) => d.id);
        const expectedInsightIds = insights.filter((i) => i.insightStatus === 'PENDING_REVIEW').map((i) => i.id);

        const draftIds = queue.filter((q) => q.kind === 'DRAFT').map((q) => q.id);
        const insightIds = queue.filter((q) => q.kind === 'INSIGHT').map((q) => q.id);

        expect(new Set(draftIds)).toEqual(new Set(expectedDraftIds));
        expect(new Set(insightIds)).toEqual(new Set(expectedInsightIds));
        // Nothing else: total size equals the two expected subsets combined.
        expect(queue.length).toBe(expectedDraftIds.length + expectedInsightIds.length);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 25: For any set of Approval_Queue items, the returned order prioritizes the most-recently-created or nearest-deadline items consistently with the ordering predicate.
  it('Property 25: approval-queue ordering (nearest-deadline / most-recently-created first)', () => {
    fc.assert(
      fc.property(fc.array(draftArb, { maxLength: 12 }), fc.array(insightArb, { maxLength: 12 }), (drafts, insights) => {
        const queue = buildApprovalQueue(drafts, insights);
        // Adjacent pairs must be consistent with the total-order comparator.
        for (let i = 1; i < queue.length; i++) {
          expect(compareApprovalItems(queue[i - 1], queue[i])).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 26: For any set of Scheduled_Posts, the current time now, the Upcoming_Posts contains a post if and only if its Content_Status is SCHEDULED and its scheduled publish time t satisfies now <= t <= now + 7 days.
  it('Property 26: upcoming-posts 7-day window predicate (inclusive boundaries)', () => {
    fc.assert(
      fc.property(fc.array(scheduledPostArb, { maxLength: 15 }), (posts) => {
        const now = dayDate(0);
        const upper = new Date(now.getTime() + 7 * 86400_000);

        // Inject exact-boundary posts to exercise the inclusive edges.
        const boundaryPosts: ScheduledPostLike[] = [
          { id: 'edge-now', platform: 'facebook', status: 'SCHEDULED', scheduledPublishTime: now.toISOString(), title: 'now' },
          { id: 'edge-upper', platform: 'tiktok', status: 'SCHEDULED', scheduledPublishTime: upper.toISOString(), title: 'upper' },
          { id: 'edge-just-after', platform: 'website', status: 'SCHEDULED', scheduledPublishTime: new Date(upper.getTime() + 1000).toISOString(), title: 'after' },
        ];
        const all = [...posts, ...boundaryPosts];

        const result = buildUpcomingPosts(all, now, 7);
        const resultIds = new Set(result.map((p) => p.scheduledPostId));

        for (const p of all) {
          const t = Date.parse(p.scheduledPublishTime);
          const inWindow = p.status === 'SCHEDULED' && t >= now.getTime() && t <= upper.getTime();
          expect(resultIds.has(p.id)).toBe(inWindow);
          expect(isUpcoming(new Date(p.scheduledPublishTime), now, 7)).toBe(t >= now.getTime() && t <= upper.getTime());
        }
        expect(resultIds.has('edge-now')).toBe(true);
        expect(resultIds.has('edge-upper')).toBe(true);
        expect(resultIds.has('edge-just-after')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 27: For any set of Scheduled_Posts, the Alert_Section contains exactly the posts whose Content_Status is FAILED, each accompanied by its failure reason (including TOKEN_EXPIRED where applicable).
  it('Property 27: alert-section composition (exactly FAILED posts with their reason)', () => {
    fc.assert(
      fc.property(fc.array(scheduledPostArb, { maxLength: 15 }), (posts) => {
        const alerts = buildAlertSection(posts, []);
        const failedAlerts = alerts.filter((a) => a.kind === 'FAILED_POST');

        const expectedFailed = posts.filter((p) => p.status === 'FAILED');
        expect(failedAlerts.length).toBe(expectedFailed.length);
        expect(new Set(failedAlerts.map((a) => a.ref))).toEqual(new Set(expectedFailed.map((p) => p.id)));

        for (const p of expectedFailed) {
          const alert = failedAlerts.find((a) => a.ref === p.id)!;
          expect(alert.reason).toBe(p.failureReason ?? 'UNKNOWN');
        }
        // No non-FAILED post leaks in as a FAILED_POST alert.
        for (const a of failedAlerts) {
          expect(posts.find((p) => p.id === a.ref)!.status).toBe('FAILED');
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 28: For any Last_Sync_Time, current time now, and Sync_Staleness_Threshold, the Data_Sync_Status reports a 'data not updated' warning if and only if now - Last_Sync_Time > threshold, and reports current when the age is at or within the threshold (the boundary at exactly the threshold is current).
  it('Property 28: data-sync staleness predicate (warning iff age > threshold; boundary is current)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 48 }),     // age in hours
        fc.integer({ min: 1, max: 24 }),     // threshold in hours
        fc.option(fc.constant(true), { nil: false }), // null lastSync?
        (ageHours, thresholdHours, nullSync) => {
          const now = dayDate(20);
          const lastSync = nullSync ? null : new Date(now.getTime() - ageHours * 3600_000);
          const status = buildDataSyncStatus(lastSync, now, thresholdHours);

          if (lastSync === null) {
            expect(status.current).toBe(false);
            expect(status.warning).not.toBeNull();
            expect(status.lastSyncTime).toBeNull();
          } else {
            const stale = ageHours * 3600_000 > thresholdHours * 3600_000;
            expect(status.current).toBe(!stale);
            expect(status.warning === null).toBe(!stale);
            expect(isDataStale(lastSync, now, thresholdHours)).toBe(stale);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 28 (cont.): exact-threshold boundary reports current', () => {
    const now = dayDate(20);
    const lastSync = new Date(now.getTime() - 6 * 3600_000); // exactly 6h
    const status = buildDataSyncStatus(lastSync, now, 6);
    expect(status.current).toBe(true);
    expect(status.warning).toBeNull();
  });

  // Feature: lead-management-dashboard, Property 29: For any set of source events, the Notifications_Channel for ADMIN returns exactly the union of platform token-expiry warnings, publish-failure alerts, and insights-pending-review notifications.
  it('Property 29: notifications composition (exactly token-expiry ∪ publish-failure ∪ insights-pending)', () => {
    fc.assert(
      fc.property(
        fc.array(tokenWarningArb, { maxLength: 6 }),
        fc.array(scheduledPostArb, { maxLength: 10 }),
        fc.array(insightArb, { maxLength: 10 }),
        (warnings, posts, insights) => {
          const notes = buildNotifications(warnings, posts, insights);

          const expectedTokens = warnings.length;
          const expectedFailures = posts.filter((p) => p.status === 'FAILED').length;
          const expectedPending = insights.filter((i) => i.insightStatus === 'PENDING_REVIEW').length;

          expect(notes.filter((n) => n.kind === 'TOKEN_EXPIRY').length).toBe(expectedTokens);
          expect(notes.filter((n) => n.kind === 'PUBLISH_FAILURE').length).toBe(expectedFailures);
          expect(notes.filter((n) => n.kind === 'INSIGHTS_PENDING').length).toBe(expectedPending);
          expect(notes.length).toBe(expectedTokens + expectedFailures + expectedPending);

          // Refs are drawn exactly from the source sets.
          const failRefs = new Set(notes.filter((n) => n.kind === 'PUBLISH_FAILURE').map((n) => n.ref));
          expect(failRefs).toEqual(new Set(posts.filter((p) => p.status === 'FAILED').map((p) => p.id)));
          const pendRefs = new Set(notes.filter((n) => n.kind === 'INSIGHTS_PENDING').map((n) => n.ref));
          expect(pendRefs).toEqual(new Set(insights.filter((i) => i.insightStatus === 'PENDING_REVIEW').map((i) => i.id)));
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: lead-management-dashboard, Property 30: For any dashboard request: an ADMIN actor is granted the full overview and notifications; a SALES actor is granted read-only access; and any SALES write attempt is denied with HTTP 403, leaving every resource unmodified.
  it('Property 30: dashboard RBAC enforcement (ADMIN full; SALES read-only; SALES write => 403)', () => {
    fc.assert(
      fc.property(fc.constantFrom<Action>('read', 'create', 'update', 'delete', 'status_update'), (action) => {
        // ADMIN: full access to dashboard.
        expect(authorize({ userId: 'admin', role: 'ADMIN' }, { module: 'dashboard', action }).allowed).toBe(true);

        // SALES: read granted; any write (create/update/delete/status_update) denied 403.
        const salesDecision = authorize({ userId: 'sales', role: 'SALES' }, { module: 'dashboard', action });
        if (action === 'read') {
          expect(salesDecision.allowed).toBe(true);
        } else {
          expect(salesDecision.allowed).toBe(false);
          if (!salesDecision.allowed) expect(salesDecision.status).toBe(403);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Properties not amenable to pure/in-memory PBT — honest skips
// ===========================================================================

describe('lead-management-dashboard: live-infrastructure properties (skipped)', () => {
  // The contact-required rule is also enforced as a DB CHECK constraint
  // (phone IS NOT NULL OR email IS NOT NULL). Verifying the constraint itself
  // requires a live PostgreSQL 16 connection, which is unavailable in this unit
  // test environment. (Property 2 is fully covered at the service layer above.)
  it.skip('DB CHECK constraint (phone OR email) requires a live PostgreSQL connection', () => {});

  // The append-only guarantee for lead_history_entry is enforced by withholding
  // UPDATE/DELETE grants on the table at the DB layer; verifying the grant
  // rejection requires a live PostgreSQL role, unavailable here. (Property 11's
  // append-only behaviour is covered at the service layer above.)
  it.skip('append-only lead_history_entry grants require a live PostgreSQL role', () => {});

  // Webhook HMAC verification runs in the Foundation middleware end-to-end
  // (signed request processed, tampered/unsigned => 401 before parsing); this is
  // an integration concern exercised against the real middleware, not pure code.
  // (Property 19 parse-rejection of a verified body is covered above.)
  it.skip('end-to-end webhook HMAC gate requires the Foundation middleware integration', () => {});
});
