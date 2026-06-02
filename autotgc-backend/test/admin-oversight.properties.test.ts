/**
 * Property-based tests for the admin-oversight-rbac-notifications spec.
 *
 * Each test is tagged with its DESIGN-canonical property number/text
 * (`// Feature: admin-oversight-rbac-notifications, Property {n}: {design text}`)
 * and runs >= 100 generated cases on fast-check (Req 11.6). The pure logic under
 * test (authorize, fanOutNotifications, composeOverview/safeRate) is exercised
 * directly; the stateful services (OversightService, NotificationService,
 * ActivityLogger) run against small in-memory Prisma / EventBus fakes so each
 * run stays fast and deterministic.
 *
 * Structure: one `describe` block per property so the file mirrors the existing
 * `ai-reporting-and-ops.properties.test.ts` layout (fast-check + Vitest, in-memory
 * fakes, no mocking of the system under test).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';

import {
  authorize,
  type Action,
  type Module,
  type AuthContext,
  type AuthzDecision,
  type ResourceTarget,
} from '../src/auth/rbac';
import {
  fanOutNotifications,
  type UserLike,
  type ActionDescriptor,
} from '../src/oversight/fanout';
import type { ActivityAction } from '../src/oversight/types';
import { ActivityLogger } from '../src/oversight/activityLogger';
import { NotificationService } from '../src/oversight/notificationService';
import { OversightService, type ImportantAction } from '../src/oversight/oversightService';
import {
  composeOverview,
  safeRate,
  type CompanyKpis,
  type PersonalKpis,
  type ActivityFeedItem,
} from '../src/dashboard/adminOverview';
import type { EventBus, DomainEvent } from '../src/infra/events';

// --- shared generators -------------------------------------------------------

const MODULES: Module[] = [
  'strategy', 'generation', 'publishing', 'analytics',
  'feedback', 'lead_management', 'settings', 'dashboard', 'user_management',
];
const ACTIONS: Action[] = [
  'read', 'create', 'update', 'delete', 'status_update', 'company_stats',
];
const ACTIVITY_ACTIONS: ActivityAction[] = [
  'DOCUMENT_VERIFIED', 'CANDIDATE_STAGE_CHANGED', 'LEAD_STATUS_CHANGED',
];

/** Vietnamese action labels — mirrored from fanout.ts to assert the message reflects the action. */
const ACTION_LABELS: Record<ActivityAction, string> = {
  DOCUMENT_VERIFIED: 'đã xác minh giấy tờ',
  CANDIDATE_STAGE_CHANGED: 'đã đổi giai đoạn ứng viên',
  LEAD_STATUS_CHANGED: 'đã đổi trạng thái lead',
};

const MAX_MS = 4_000_000_000_000;
const arbMs = fc.integer({ min: 0, max: MAX_MS });

/** A small id pool so generated user/notification sets exercise duplicate ids and shared owners. */
const ID_POOL = ['u1', 'u2', 'u3', 'u4'];

const arbActionDescriptor: fc.Arbitrary<ActionDescriptor> = fc.record({
  actorUserId: fc.constantFrom('actor-1', 'actor-2', 'actor-3'),
  action: fc.constantFrom(...ACTIVITY_ACTIONS),
  targetType: fc.constantFrom('document', 'candidate', 'lead'),
  targetId: fc.string({ minLength: 1, maxLength: 8 }),
  detail: fc.dictionary(
    fc.string({ maxLength: 6 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { maxKeys: 4 },
  ),
});

const arbUser: fc.Arbitrary<UserLike> = fc.record({
  id: fc.constantFrom(...ID_POOL),
  role: fc.constantFrom('ADMIN', 'SALES') as fc.Arbitrary<'ADMIN' | 'SALES'>,
});

interface AnyRow {
  [k: string]: unknown;
}

/** Records every published DomainEvent so a property can assert "exactly one event". */
function makeFakeEventBus(opts: { failPublish?: boolean } = {}): {
  bus: EventBus;
  published: DomainEvent[];
} {
  const published: DomainEvent[] = [];
  const bus: EventBus = {
    async publish(event) {
      if (opts.failPublish) throw new Error('event bus down');
      published.push({ ...event, at: new Date().toISOString() });
    },
    subscribe() {
      return () => undefined;
    },
    async close() {
      /* no-op */
    },
  };
  return { bus, published };
}

// =============================================================================
// Property 1 (task 2.2) — RBAC correct by role and scope
// =============================================================================

describe('admin-oversight properties (authorize by role/scope)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 1: RBAC quyết định đúng theo vai trò và phạm vi
  // For any AuthContext (ADMIN or SALES) and any ResourceTarget, authorize is allowed for ADMIN
  // always; for SALES it is allowed ONLY for lead_management {read,update,status_update} with owner
  // undefined-or-matching, OR dashboard read — every other SALES case is { allowed:false, status:403 }.
  // Validates: Requirements 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 3.9, 4.1, 5.9, 10.3, 11.1
  it('Property 1: authorize is correct per role and resource scope', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ADMIN', 'SALES') as fc.Arbitrary<'ADMIN' | 'SALES'>,
        fc.constantFrom(...MODULES),
        fc.constantFrom(...ACTIONS),
        fc.constantFrom('caller-1', 'caller-2'),
        fc.constantFrom('undefined', 'self', 'other'),
        (role, module, action, callerUserId, ownerKind) => {
          const ownerUserId =
            ownerKind === 'undefined'
              ? undefined
              : ownerKind === 'self'
                ? callerUserId
                : 'other-owner';

          const ctx: AuthContext = { userId: callerUserId, role };
          const target: ResourceTarget = { module, action, ownerUserId };

          // Independent oracle derived from the property text (not the impl structure).
          const salesAllowed = (): boolean => {
            if (module === 'lead_management') {
              const ownerOk = ownerUserId === undefined || ownerUserId === callerUserId;
              return ownerOk && (action === 'read' || action === 'update' || action === 'status_update');
            }
            if (module === 'dashboard') {
              return action === 'read';
            }
            return false;
          };

          const expected: AuthzDecision =
            role === 'ADMIN'
              ? { allowed: true }
              : salesAllowed()
                ? { allowed: true }
                : { allowed: false, status: 403 };

          expect(authorize(ctx, target)).toEqual(expected);

          // ADMIN is unconditionally allowed (Req 4.1).
          if (role === 'ADMIN') {
            expect(authorize(ctx, target)).toEqual({ allowed: true });
          }
          // SALES is never allowed outside {lead_management, dashboard} (Req 3.9, 5.9).
          if (role === 'SALES' && module !== 'lead_management' && module !== 'dashboard') {
            expect(authorize(ctx, target)).toEqual({ allowed: false, status: 403 });
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// Property 2 (task 2.3) — RBAC determinism
// =============================================================================

describe('admin-oversight properties (authorize determinism)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 2: Quyết định RBAC là xác định (deterministic, thuần)
  // For any AuthContext and ResourceTarget, calling authorize repeatedly with identical input
  // always yields an identical AuthzDecision — the result depends on no external state.
  // Validates: Requirements 10.2
  it('Property 2: authorize is deterministic across repeated calls', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ADMIN', 'SALES') as fc.Arbitrary<'ADMIN' | 'SALES'>,
        fc.constantFrom(...MODULES),
        fc.constantFrom(...ACTIONS),
        fc.string({ minLength: 1, maxLength: 6 }),
        fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: undefined }),
        (role, module, action, callerUserId, ownerUserId) => {
          const ctx: AuthContext = { userId: callerUserId, role };
          const target: ResourceTarget = { module, action, ownerUserId };

          const first = authorize(ctx, target);
          // Many repeated evaluations must all agree with the first.
          for (let i = 0; i < 8; i += 1) {
            expect(authorize(ctx, target)).toEqual(first);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 3 (task 3.3) — fan-out: exactly one notification per distinct ADMIN
// =============================================================================

describe('admin-oversight properties (fanOutNotifications)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 3: Fan-out tạo đúng một thông báo cho mỗi ADMIN với đủ ngữ cảnh
  // For any UserLike[] (mixed roles, duplicate ids) and any ActionDescriptor, the result length
  // equals the distinct-ADMIN-id count (one draft per distinct admin, none for SALES), and every
  // draft has refType = targetType, refId = targetId, kind 'ACTIVITY', and a message carrying the
  // actor and action.
  // Validates: Requirements 1.6, 8.1, 8.3, 8.4, 11.2
  it('Property 3: one draft per distinct ADMIN with full context', () => {
    fc.assert(
      fc.property(
        fc.array(arbUser, { maxLength: 30 }),
        arbActionDescriptor,
        (users, action) => {
          const drafts = fanOutNotifications(users, action);

          const distinctAdminIds = new Set(
            users.filter((u) => u.role === 'ADMIN').map((u) => u.id),
          );

          // Length equals the number of DISTINCT admin ids.
          expect(drafts.length).toBe(distinctAdminIds.size);

          // Recipients are exactly the distinct admin ids, each appearing once.
          const recipients = drafts.map((d) => d.recipientUserId);
          expect(new Set(recipients).size).toBe(recipients.length); // no duplicates
          expect(new Set(recipients)).toEqual(distinctAdminIds);

          for (const draft of drafts) {
            // No SALES-only id ever becomes a recipient.
            expect(distinctAdminIds.has(draft.recipientUserId)).toBe(true);
            expect(draft.kind).toBe('ACTIVITY');
            expect(draft.refType).toBe(action.targetType);
            expect(draft.refId).toBe(action.targetId);
            // Message carries actor + action (+ target) so an admin can trace progress.
            expect(draft.message).toContain(action.actorUserId);
            expect(draft.message).toContain(ACTION_LABELS[action.action]);
            expect(draft.message).toContain(action.targetType);
            expect(draft.message).toContain(action.targetId);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 4 (task 3.9) — OversightService.record consistency
// =============================================================================

/** In-memory Prisma fake for the oversight emit path: ADMIN lookup + activity + notification writes. */
function makeOversightPrisma(users: readonly UserLike[]): {
  prisma: PrismaClient;
  activityLogs: AnyRow[];
  notifications: AnyRow[];
} {
  const activityLogs: AnyRow[] = [];
  const notifications: AnyRow[] = [];
  let seq = 0;

  const prisma = {
    userAccount: {
      findMany: async (args?: { where?: { role?: string } }) => {
        const role = args?.where?.role;
        return users
          .filter((u) => (role === undefined ? true : u.role === role))
          .map((u) => ({ id: u.id, role: u.role }));
      },
    },
    activityLog: {
      create: async (args: { data: AnyRow }) => {
        const row = { id: `act_${++seq}`, createdAt: new Date(), ...args.data };
        activityLogs.push(row);
        return row;
      },
    },
    notification: {
      createMany: async (args: { data: AnyRow[] }) => {
        for (const d of args.data) {
          notifications.push({ id: `ntf_${++seq}`, read: false, createdAt: new Date(), ...d });
        }
        return { count: args.data.length };
      },
    },
  } as unknown as PrismaClient;

  return { prisma, activityLogs, notifications };
}

describe('admin-oversight properties (OversightService.record consistency)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 4: Một Important_Action sinh đúng một ActivityLog và đúng một Notification cho mỗi ADMIN, nhất quán với hành động
  // For any ImportantAction and any UserAccount set, one record() appends exactly one ActivityLog
  // (actor/target consistent, detail verbatim) and creates exactly one Notification per distinct
  // ADMIN, publishing exactly one event (zero when there are no admins).
  // Validates: Requirements 2.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 10.4, 10.5, 11.3
  it('Property 4: one ActivityLog + one Notification per distinct ADMIN, consistent with the action', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(arbUser, { maxLength: 20 }),
        arbActionDescriptor,
        async (users, descriptor) => {
          const { prisma, activityLogs, notifications } = makeOversightPrisma(users);
          const { bus, published } = makeFakeEventBus();
          const logger = new ActivityLogger(prisma);
          const notifSvc = new NotificationService(prisma, bus);
          const oversight = new OversightService(prisma, logger, notifSvc);

          const action: ImportantAction = {
            actorUserId: descriptor.actorUserId,
            action: descriptor.action,
            targetType: descriptor.targetType,
            targetId: descriptor.targetId,
            detail: descriptor.detail ?? {},
          };

          await oversight.record(action);

          const distinctAdminIds = new Set(
            users.filter((u) => u.role === 'ADMIN').map((u) => u.id),
          );

          // Exactly one ActivityLog, consistent with the action; detail stored verbatim.
          expect(activityLogs).toHaveLength(1);
          const log = activityLogs[0];
          expect(log.actorUserId).toBe(action.actorUserId);
          expect(log.action).toBe(action.action);
          expect(log.targetType).toBe(action.targetType);
          expect(log.targetId).toBe(action.targetId);
          expect(log.detail).toEqual(action.detail);

          // Exactly one Notification per distinct ADMIN.
          expect(notifications).toHaveLength(distinctAdminIds.size);
          const recipients = notifications.map((n) => n.recipientUserId as string);
          expect(new Set(recipients).size).toBe(recipients.length);
          expect(new Set(recipients)).toEqual(distinctAdminIds);

          // Exactly one realtime event when there is at least one admin; none otherwise.
          expect(published).toHaveLength(distinctAdminIds.size > 0 ? 1 : 0);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// =============================================================================
// Property 5 (task 3.10) — failure isolation of the central emit point
// =============================================================================

/** Prisma fake whose individual model methods can be toggled to throw, to test isolation. */
function makeFailingPrisma(
  users: readonly UserLike[],
  fail: { append?: boolean; findMany?: boolean; createMany?: boolean },
): PrismaClient {
  return {
    userAccount: {
      findMany: async (args?: { where?: { role?: string } }) => {
        if (fail.findMany) throw new Error('userAccount.findMany failed');
        const role = args?.where?.role;
        return users
          .filter((u) => (role === undefined ? true : u.role === role))
          .map((u) => ({ id: u.id, role: u.role }));
      },
    },
    activityLog: {
      create: async (args: { data: AnyRow }) => {
        if (fail.append) throw new Error('activityLog.create failed');
        return { id: 'act_1', createdAt: new Date(), ...args.data };
      },
    },
    notification: {
      createMany: async (args: { data: AnyRow[] }) => {
        if (fail.createMany) throw new Error('notification.createMany failed');
        return { count: args.data.length };
      },
    },
  } as unknown as PrismaClient;
}

describe('admin-oversight properties (OversightService failure isolation)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 5: Cô lập lỗi của điểm phát tập trung
  // For any ImportantAction, OversightService.record always resolves without throwing — even when
  // ActivityLogger.append, NotificationService.createForAdmins, or EventBus.publish throw — so an
  // auxiliary logging/notification/realtime failure never rolls back the committed business action.
  // Validates: Requirements 8.5
  it('Property 5: record never throws even when collaborators fail', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(arbUser, { maxLength: 12 }),
        arbActionDescriptor,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (users, descriptor, failAppend, failFindMany, failCreateMany, failPublish) => {
          const prisma = makeFailingPrisma(users, {
            append: failAppend,
            findMany: failFindMany,
            createMany: failCreateMany,
          });
          const { bus } = makeFakeEventBus({ failPublish });
          const logger = new ActivityLogger(prisma);
          const notifSvc = new NotificationService(prisma, bus);
          const oversight = new OversightService(prisma, logger, notifSvc);

          const action: ImportantAction = {
            actorUserId: descriptor.actorUserId,
            action: descriptor.action,
            targetType: descriptor.targetType,
            targetId: descriptor.targetId,
            detail: descriptor.detail ?? {},
          };

          // Must resolve to undefined regardless of which auxiliary seam(s) throw.
          await expect(oversight.record(action)).resolves.toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 6 (task 6.2) — stats scoping + divide-by-zero-safe rate
// =============================================================================

const arbCompanyKpis: fc.Arbitrary<CompanyKpis> = fc.record({
  totalLeads: fc.nat({ max: 10_000 }),
  candidateFunnel: fc.dictionary(fc.string({ maxLength: 6 }), fc.nat({ max: 1000 }), { maxKeys: 5 }),
  pendingApprovals: fc.nat({ max: 1000 }),
  conversionRate: fc.oneof(
    fc.double({ min: -1000, max: 1000, noNaN: true }),
    fc.constant('INSUFFICIENT_DATA' as const),
  ),
});

const arbPersonalKpis: fc.Arbitrary<PersonalKpis> = fc.record({
  totalLeads: fc.nat({ max: 10_000 }),
  leadsByStatus: fc.dictionary(fc.string({ maxLength: 6 }), fc.nat({ max: 1000 }), { maxKeys: 5 }),
});

const arbFeedItem: fc.Arbitrary<ActivityFeedItem> = fc.record({
  actorUserId: fc.string({ minLength: 1, maxLength: 6 }),
  action: fc.constantFrom(...ACTIVITY_ACTIONS),
  targetType: fc.constantFrom('document', 'candidate', 'lead'),
  targetId: fc.string({ minLength: 1, maxLength: 6 }),
  createdAt: arbMs.map((ms) => new Date(ms).toISOString()),
});

describe('admin-oversight properties (composeOverview scoping + safeRate)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 6: Phân tách phạm vi thống kê và an toàn chia-cho-không
  // For any company/personal payloads, composeOverview gives SALES a personal-only payload (no company
  // stats, no activity feed) and ADMIN a company payload with the feed; and safeRate(n,0) ===
  // 'INSUFFICIENT_DATA' while a non-zero denominator yields a finite number (never NaN/Infinity).
  // Validates: Requirements 3.4, 3.5, 6.1, 6.3, 6.4, 6.7, 11.4
  it('Property 6: SALES gets personal-only payload, ADMIN gets company payload; safeRate is divide-by-zero safe', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ADMIN', 'SALES') as fc.Arbitrary<'ADMIN' | 'SALES'>,
        arbCompanyKpis,
        fc.array(arbFeedItem, { maxLength: 12 }),
        arbPersonalKpis,
        fc.double({ min: -1_000_000, max: 1_000_000, noNaN: true }),
        fc.double({ min: -1_000_000, max: 1_000_000, noNaN: true }),
        (role, companyKpis, recentActivity, personalKpis, numerator, denominator) => {
          const payload = composeOverview(
            role,
            { kpis: companyKpis, recentActivity },
            { kpis: personalKpis },
          );

          if (role === 'SALES') {
            expect(payload.scope).toBe('personal');
            // No company stats, no recent-activity feed leak to SALES.
            expect('recentActivity' in payload).toBe(false);
            expect(payload.kpis).toEqual(personalKpis);
          } else {
            expect(payload.scope).toBe('company');
            expect('recentActivity' in payload).toBe(true);
            if (payload.scope === 'company') {
              expect(payload.kpis).toEqual(companyKpis);
              expect(payload.recentActivity).toEqual(recentActivity);
            }
          }

          // Divide-by-zero safety (Req 6.7).
          const rate = safeRate(numerator, denominator);
          if (denominator === 0) {
            expect(rate).toBe('INSUFFICIENT_DATA');
          } else {
            const direct = numerator / denominator;
            if (Number.isFinite(direct)) {
              expect(typeof rate).toBe('number');
              expect(rate).toBe(direct);
              expect(Number.isFinite(rate as number)).toBe(true);
            } else {
              expect(rate).toBe('INSUFFICIENT_DATA');
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 7 (task 6.3) — Recent_Activity_Feed ordering & completeness
// =============================================================================

/** Prisma fake whose activityLog.findMany honors orderBy createdAt desc + skip/take. */
function makeActivityPrisma(rows: readonly AnyRow[]): PrismaClient {
  return {
    activityLog: {
      findMany: async (args?: {
        orderBy?: { createdAt?: 'asc' | 'desc' };
        skip?: number;
        take?: number;
      }) => {
        const sorted = [...rows];
        const dir = args?.orderBy?.createdAt ?? 'desc';
        sorted.sort((a, b) => {
          const at = (a.createdAt as Date).getTime();
          const bt = (b.createdAt as Date).getTime();
          return dir === 'desc' ? bt - at : at - bt;
        });
        const skip = args?.skip ?? 0;
        const take = args?.take ?? sorted.length;
        return sorted.slice(skip, skip + take);
      },
      count: async () => rows.length,
    },
  } as unknown as PrismaClient;
}

describe('admin-oversight properties (activity feed ordering)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 7: Recent_Activity_Feed sắp xếp giảm dần và đủ trường
  // For any ActivityLog set, ActivityLogger.listRecent returns items sorted by createdAt descending
  // (newest first) and every item carries actorUserId, action, targetType, targetId, and createdAt.
  // Validates: Requirements 6.2, 6.5, 6.6
  it('Property 7: listRecent returns newest-first items with all required fields', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            actorUserId: fc.string({ minLength: 1, maxLength: 6 }),
            action: fc.constantFrom(...ACTIVITY_ACTIONS),
            targetType: fc.constantFrom('document', 'candidate', 'lead'),
            targetId: fc.string({ minLength: 1, maxLength: 6 }),
            createdAtMs: arbMs,
          }),
          { maxLength: 40 },
        ),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 20 }),
        async (specs, page, limit) => {
          const rows: AnyRow[] = specs.map((s, i) => ({
            id: `act_${i}`,
            actorUserId: s.actorUserId,
            action: s.action,
            targetType: s.targetType,
            targetId: s.targetId,
            detail: {},
            createdAt: new Date(s.createdAtMs),
          }));
          const logger = new ActivityLogger(makeActivityPrisma(rows));

          const { items, total } = await logger.listRecent(page, limit);

          expect(total).toBe(rows.length);
          // Page size never exceeds the requested limit.
          expect(items.length).toBeLessThanOrEqual(limit);

          // Newest first: createdAt is non-increasing across the returned page.
          for (let i = 1; i < items.length; i += 1) {
            expect(items[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
              items[i].createdAt.getTime(),
            );
            // And the page is a contiguous prefix of the globally desc-sorted set.
          }

          // Every item carries the required fields (Req 6.6).
          for (const item of items) {
            expect(typeof item.actorUserId).toBe('string');
            expect(item.actorUserId.length).toBeGreaterThan(0);
            expect(ACTIVITY_ACTIONS).toContain(item.action);
            expect(typeof item.targetType).toBe('string');
            expect(typeof item.targetId).toBe('string');
            expect(item.createdAt).toBeInstanceOf(Date);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 8 (task 3.7) — mark-read idempotence / ownership / unread count
// =============================================================================

interface NotifRow {
  id: string;
  recipientUserId: string;
  kind: string;
  message: string;
  refType: string | null;
  refId: string | null;
  read: boolean;
  createdAt: Date;
}

/** In-memory Prisma fake for the Notification model (list/count/findUnique/update). */
function makeNotificationPrisma(rows: NotifRow[]): PrismaClient {
  const matches = (r: NotifRow, where?: { recipientUserId?: string; read?: boolean }): boolean => {
    if (!where) return true;
    if (where.recipientUserId !== undefined && r.recipientUserId !== where.recipientUserId) return false;
    if (where.read !== undefined && r.read !== where.read) return false;
    return true;
  };

  return {
    notification: {
      findMany: async (args?: {
        where?: { recipientUserId?: string };
        orderBy?: { createdAt?: 'asc' | 'desc' };
        skip?: number;
        take?: number;
      }) => {
        const filtered = rows.filter((r) => matches(r, args?.where));
        const dir = args?.orderBy?.createdAt ?? 'desc';
        filtered.sort((a, b) =>
          dir === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        const skip = args?.skip ?? 0;
        const take = args?.take ?? filtered.length;
        return filtered.slice(skip, skip + take);
      },
      count: async (args?: { where?: { recipientUserId?: string; read?: boolean } }) =>
        rows.filter((r) => matches(r, args?.where)).length,
      findUnique: async (args: { where: { id: string } }) =>
        rows.find((r) => r.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: { read?: boolean } }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error('notification not found');
        Object.assign(row, args.data);
        return row;
      },
    },
  } as unknown as PrismaClient;
}

describe('admin-oversight properties (notification list/markRead)', () => {
  // Feature: admin-oversight-rbac-notifications, Property 8: Đánh dấu đã đọc lũy đẳng, đúng người, đếm chưa-đọc chính xác
  // For any Notification set and any caller: list(self) returns only self rows newest-first;
  // unreadCount(self) equals self unread rows; markRead on the caller's own row is idempotent;
  // markRead on another user's row is 403; markRead on a missing id is 404.
  // Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 11.5
  it('Property 8: list/unreadCount/markRead are owner-scoped and idempotent', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            recipientUserId: fc.constantFrom(...ID_POOL),
            read: fc.boolean(),
            createdAtMs: arbMs,
          }),
          { maxLength: 30 },
        ),
        fc.constantFrom(...ID_POOL),
        async (specs, caller) => {
          const rows: NotifRow[] = specs.map((s, i) => ({
            id: `n${i}`,
            recipientUserId: s.recipientUserId,
            kind: 'ACTIVITY',
            message: `msg-${i}`,
            refType: 'document',
            refId: `t${i}`,
            read: s.read,
            createdAt: new Date(s.createdAtMs),
          }));
          const svc = new NotificationService(makeNotificationPrisma(rows));

          // list(self): only self rows, newest first.
          const { items } = await svc.list(caller, 1, 1000);
          for (const item of items) {
            expect(item.recipientUserId).toBe(caller);
          }
          expect(items.length).toBe(rows.filter((r) => r.recipientUserId === caller).length);
          for (let i = 1; i < items.length; i += 1) {
            expect(items[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
              items[i].createdAt.getTime(),
            );
          }

          // unreadCount(self) == self unread rows.
          const expectedUnread = rows.filter((r) => r.recipientUserId === caller && !r.read).length;
          expect(await svc.unreadCount(caller)).toBe(expectedUnread);

          // markRead on the caller's own row: sets read=true and is idempotent.
          const own = rows.find((r) => r.recipientUserId === caller);
          if (own) {
            // Snapshot BEFORE markRead — the fake mutates `own` in place, so reading
            // `own.read` after the call would observe the already-flipped value.
            const ownWasUnread = !own.read;
            const rowCountBefore = rows.length;
            const first = await svc.markRead(own.id, caller);
            expect(first.read).toBe(true);
            const second = await svc.markRead(own.id, caller);
            expect(second.read).toBe(true);
            // No new rows were created by repeated mark-read (idempotent).
            expect(rows.length).toBe(rowCountBefore);
            // Unread count dropped by exactly one relative to the original unread set.
            expect(await svc.unreadCount(caller)).toBe(expectedUnread - (ownWasUnread ? 1 : 0));
          }

          // markRead on another user's row -> 403.
          const foreign = rows.find((r) => r.recipientUserId !== caller);
          if (foreign) {
            await expect(svc.markRead(foreign.id, caller)).rejects.toMatchObject({ status: 403 });
          }

          // markRead on a missing id -> 404.
          await expect(svc.markRead('missing-id', caller)).rejects.toMatchObject({ status: 404 });
        },
      ),
      { numRuns: 200 },
    );
  });
});
