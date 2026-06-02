/**
 * Unit / edge tests for the drag-and-drop Schedule_Board + Approval_Queue wiring
 * (ai-reporting-and-ops-enhancements spec — task 6.8).
 *
 * Covers the route/service edge cases that back the DnD endpoints wired in
 * `routes/index.ts`:
 *   - Rescheduling a ScheduledPost that is NOT in status SCHEDULED -> 409 (Req 9.5).
 *   - Rescheduling to a non-future time -> 400 (Req 9.6).
 *   - SALES attempting any DnD write (Schedule_Board `strategy`/update,
 *     Approval_Queue `feedback`/update) -> 403 (Req 9.7) — asserted against the
 *     pure RBAC policy the route guards build.
 *   - `validateReorder` rejecting unknown / duplicate ids -> 400.
 *
 * The reschedule cases reuse the in-memory Prisma fake pattern from
 * `content.test.ts`; RBAC and reorder validation are pure so they are exercised
 * directly (mirroring `auth.test.ts` which tests `authorize` directly).
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../src/auth/jwt';
import { ScheduleBoardService } from '../src/content/scheduleBoardService';
import { validateReorder } from '../src/content/reorder';
import { authorize } from '../src/auth/rbac';
import type { AuthContext, ResourceTarget } from '../src/auth/rbac';
import { ConflictError, ValidationError } from '../src/infra/errors';

// ---- Test doubles -----------------------------------------------------------

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

/**
 * Prisma fake for the ScheduledPost reschedule path. Tracks any `update` so the
 * tests can assert that a rejected reschedule performs no write (time unchanged).
 */
function fakeReschedulePrisma(post: { id: string; status: string; scheduledAt: Date } | null): {
  prisma: PrismaClient;
  updates: Array<{ id: string; scheduledAt: Date }>;
} {
  const updates: Array<{ id: string; scheduledAt: Date }> = [];
  const prisma = {
    scheduledPost: {
      findUnique: async () => post,
      update: async (args: { where: { id: string }; data: { scheduledAt: Date } }) => {
        updates.push({ id: args.where.id, scheduledAt: args.data.scheduledAt });
        return { id: args.where.id, scheduledAt: args.data.scheduledAt };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, updates };
}

const NOW = new Date('2025-06-01T00:00:00.000Z');
const FUTURE = new Date('2025-06-10T00:00:00.000Z');
const PAST = new Date('2025-05-01T00:00:00.000Z');

describe('Schedule_Board reschedule edge cases', () => {
  // Req 9.5: a non-SCHEDULED ScheduledPost rejects reschedule with 409 and keeps its time.
  it('rejects rescheduling a non-SCHEDULED post with 409 (Req 9.5)', async () => {
    for (const status of ['PUBLISHED', 'DRAFT', 'PUBLISHING', 'FAILED']) {
      const original = new Date('2025-06-02T00:00:00.000Z');
      const { prisma, updates } = fakeReschedulePrisma({ id: 'sp-1', status, scheduledAt: original });
      const service = new ScheduleBoardService(prisma, undefined, fixedClock(NOW));

      const err = await service.rescheduleScheduledPost('sp-1', FUTURE).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).status).toBe(409);
      // No write occurred — the original time is preserved.
      expect(updates).toHaveLength(0);
    }
  });

  // Req 9.6: a non-future target time rejects reschedule with 400 and keeps its time.
  it('rejects rescheduling a SCHEDULED post to a non-future time with 400 (Req 9.6)', async () => {
    for (const newTime of [PAST, NOW]) {
      const original = new Date('2025-06-02T00:00:00.000Z');
      const { prisma, updates } = fakeReschedulePrisma({
        id: 'sp-1',
        status: 'SCHEDULED',
        scheduledAt: original,
      });
      const service = new ScheduleBoardService(prisma, undefined, fixedClock(NOW));

      const err = await service.rescheduleScheduledPost('sp-1', newTime).catch((e) => e);

      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(400);
      expect(updates).toHaveLength(0);
    }
  });

  // Sanity: a SCHEDULED post moved to a strictly-future time succeeds and writes once.
  it('reschedules a SCHEDULED post to a future time (Req 9.4)', async () => {
    const original = new Date('2025-06-02T00:00:00.000Z');
    const { prisma, updates } = fakeReschedulePrisma({
      id: 'sp-1',
      status: 'SCHEDULED',
      scheduledAt: original,
    });
    const service = new ScheduleBoardService(prisma, undefined, fixedClock(NOW));

    const result = await service.rescheduleScheduledPost('sp-1', FUTURE);

    expect(result.scheduledAt.getTime()).toBe(FUTURE.getTime());
    expect(updates).toHaveLength(1);
    expect(updates[0].scheduledAt.getTime()).toBe(FUTURE.getTime());
  });
});

describe('Schedule_Board / Approval_Queue RBAC (SALES drag-and-drop -> 403)', () => {
  // Req 9.7: SALES is denied the DnD write targets the routes build. The
  // Schedule_Board reorder/reschedule routes use module 'strategy'/update; the
  // Approval_Queue reorder route uses module 'feedback'/update.
  const dndTargets: ResourceTarget[] = [
    { module: 'strategy', action: 'update' },
    { module: 'feedback', action: 'update' },
  ];

  it('denies SALES on every DnD write target with status 403 (Req 9.7)', () => {
    const sales: AuthContext = { userId: 'sales-1', role: 'SALES' };
    for (const target of dndTargets) {
      const decision = authorize(sales, target);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.status).toBe(403);
      }
    }
  });

  it('allows ADMIN on every DnD write target', () => {
    const admin: AuthContext = { userId: 'admin-1', role: 'ADMIN' };
    for (const target of dndTargets) {
      expect(authorize(admin, target).allowed).toBe(true);
    }
  });
});

describe('validateReorder rejects malformed Reorder_Requests with 400', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('rejects an unknown id with a 400 ValidationError', () => {
    const err = (() => {
      try {
        validateReorder(items, { orderedIds: ['a', 'zzz'] });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).status).toBe(400);
    expect((err as ValidationError).code).toBe('REORDER_UNKNOWN_ID');
  });

  it('rejects a duplicate id with a 400 ValidationError', () => {
    const err = (() => {
      try {
        validateReorder(items, { orderedIds: ['a', 'b', 'a'] });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).status).toBe(400);
    expect((err as ValidationError).code).toBe('REORDER_DUPLICATE_ID');
  });

  it('accepts a well-formed subset without throwing', () => {
    expect(() => validateReorder(items, { orderedIds: ['c', 'a'] })).not.toThrow();
    expect(() => validateReorder(items, { orderedIds: [] })).not.toThrow();
  });
});
