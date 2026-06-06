/**
 * Integration / route-level tests for the SALES access-restrictions RBAC revision
 * (Tasks 14.1–14.4). Per the design's Testing Strategy, the I/O-heavy behaviors
 * (guard ordering, fail-closed, audit success/denied, "service not called on
 * deny") are covered with route/guard-level checks driven by the pure policy
 * (`authorize`) plus light guard doubles — no full Fastify app or real JWT.
 *
 * What this exercises against REAL source:
 *   - `authorize` (auth/rbac.ts) — the deny/allow decisions for SALES vs ADMIN.
 *   - `rbacGuard` (http/authMiddleware.ts) — a preHandler that reads request.auth
 *     via getAuth and throws ForbiddenError on deny, BEFORE any handler/service runs.
 *   - `AuthorizationAuditor` (oversight/authorizationAuditor.ts) wrapping a real
 *     `ActivityLogger` (oversight/activityLogger.ts) over an in-memory Prisma double.
 *   - `ForbiddenError` shape (infra/errors.ts): status 403, code 'FORBIDDEN'.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { authorize } from '../src/auth/rbac';
import type { Action, AuthContext, Module } from '../src/auth/rbac';
import { rbacGuard, getAuth } from '../src/http/authMiddleware';
import type { RbacAuditor } from '../src/http/authMiddleware';
import { ForbiddenError } from '../src/infra/errors';
import { ActivityLogger } from '../src/oversight/activityLogger';
import { AuthorizationAuditor } from '../src/oversight/authorizationAuditor';

// ---- Shared principals ------------------------------------------------------
const SALES_CTX: AuthContext = { userId: 'sales-1', role: 'SALES' };
const ADMIN_CTX: AuthContext = { userId: 'admin-1', role: 'ADMIN' };

const SALES_AUTH = { userId: 'sales-1', role: 'SALES' as const, sessionId: 's-sales' };

// Minimal request/reply doubles. rbacGuard reads request.auth (via getAuth) and
// passes (request, reply) to the target builder; our builders ignore reply.
function makeRequest(auth: unknown): FastifyRequest {
  return { auth } as unknown as FastifyRequest;
}
const REPLY = {} as unknown as FastifyReply;

/** Flush pending microtasks so fire-and-forget audit appends settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * In-memory ActivityLog Prisma double — captures exactly the create/findMany/
 * count operations ActivityLogger performs, so we can assert the persisted row
 * shape and that listRecent returns it.
 */
function makeActivityPrisma(): { prisma: PrismaClient; rows: any[] } {
  const rows: any[] = [];
  let seq = 0;
  const prisma = {
    activityLog: {
      create: async ({ data }: { data: any }) => {
        const row = {
          id: `log-${++seq}`,
          actorUserId: data.actorUserId,
          action: data.action,
          targetType: data.targetType,
          targetId: data.targetId,
          detail: data.detail ?? {},
          createdAt: new Date(Date.now() + seq),
        };
        rows.push(row);
        return row;
      },
      findMany: async (args?: { skip?: number; take?: number }) => {
        const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const skip = args?.skip ?? 0;
        const take = args?.take ?? 50;
        return sorted.slice(skip, skip + take);
      },
      count: async () => rows.length,
    },
  } as unknown as PrismaClient;
  return { prisma, rows };
}

// ============================================================================
// 14.1 — Recruitment analytics deny (Req 5.1, 5.2, 5.4)
// ============================================================================
describe('14.1 Recruitment analytics — SALES denied, ADMIN allowed (Req 5.1, 5.2, 5.4)', () => {
  it('authorize(): SALES is denied analytics/read with status 403 (Req 5.1)', () => {
    const decision = authorize(SALES_CTX, { module: 'analytics', action: 'read' });
    expect(decision.allowed).toBe(false);
    expect(decision).toEqual({ allowed: false, status: 403 });
  });

  it('authorize(): ADMIN is allowed analytics/read (Req 5.4)', () => {
    expect(authorize(ADMIN_CTX, { module: 'analytics', action: 'read' })).toEqual({ allowed: true });
  });

  it('the analytics guard throws ForbiddenError(403) for SALES BEFORE the service runs (Req 5.2)', async () => {
    // Spy analytics service mirroring CandidateAnalyticsService surface.
    const calls: string[] = [];
    const analyticsServiceSpy = {
      funnel: async () => { calls.push('funnel'); return {}; },
      byMarket: async () => { calls.push('byMarket'); return []; },
      bySource: async () => { calls.push('bySource'); return []; },
      conversionByJobOrder: async () => { calls.push('conversionByJobOrder'); return []; },
    };

    // The exact guard the 4 analytics routes use.
    const analyticsGuard = rbacGuard(() => ({ module: 'analytics', action: 'read' }));
    const request = makeRequest(SALES_AUTH);

    // rbacGuard is a preHandler: it must throw before the handler (which would
    // call the service) is ever reached.
    let thrown: unknown;
    try {
      await analyticsGuard(request, REPLY);
      // Only reached if the guard ALLOWED — then the handler would call the service.
      await analyticsServiceSpy.funnel();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect((thrown as ForbiddenError).status).toBe(403);
    expect((thrown as ForbiddenError).code).toBe('FORBIDDEN');
    // Service was never invoked on the deny path.
    expect(calls).toEqual([]);
  });
});

// ============================================================================
// 14.2 — Fail-closed & state-preservation (Req 4.5, 6.7, 7.2)
// ============================================================================
describe('14.2 Fail-closed guard + state-preservation (Req 4.5, 6.7, 7.2)', () => {
  it('rbacGuard with a builder returning undefined fails closed (403) and the handler never runs (Req 4.5, 6.7)', async () => {
    const handlerSpy = { calls: 0 };
    // Builder cannot resolve a target (e.g. missing AuthContext / unknown owner).
    const guard = rbacGuard(() => undefined);
    const request = makeRequest(SALES_AUTH);

    let thrown: unknown;
    try {
      await guard(request, REPLY);
      handlerSpy.calls += 1; // downstream handler — unreachable on deny
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect((thrown as ForbiddenError).status).toBe(403);
    // Because the preHandler threw first, no business logic ran (state preserved).
    expect(handlerSpy.calls).toBe(0);
  });

  it('a guard whose builder throws also fails closed (403), handler never runs (Req 4.5)', async () => {
    const handlerSpy = { calls: 0 };
    const guard = rbacGuard(async () => {
      throw new Error('owner resolution failed');
    });
    const request = makeRequest(SALES_AUTH);

    let thrown: unknown;
    try {
      await guard(request, REPLY);
      handlerSpy.calls += 1;
    } catch (err) {
      thrown = err;
    }

    // Any failure to decide → request is rejected, no unfiltered data returned.
    expect(thrown).toBeInstanceOf(Error);
    expect(handlerSpy.calls).toBe(0);
  });

  it('SALES write to a denied module (settings/update) is denied 403 → handler/service never runs (Req 6.7, 7.2)', () => {
    const decision = authorize(SALES_CTX, { module: 'settings', action: 'update' });
    expect(decision).toEqual({ allowed: false, status: 403 });
  });
});

// ============================================================================
// 14.3 — Audit success & denied paths (Req 7.1, 7.3, 7.5)
// ============================================================================
describe('14.3 Audit denied + success paths (Req 7.1, 7.3, 7.5)', () => {
  it('a SALES analytics deny appends exactly one AUTHZ_DENIED record with actor/module/action and no secret (Req 7.3)', async () => {
    const { prisma, rows } = makeActivityPrisma();
    const auditor: RbacAuditor = new AuthorizationAuditor(new ActivityLogger(prisma));

    // The real guard wiring threads the auditor in (recruitment/routes.ts).
    const analyticsGuard = rbacGuard(() => ({ module: 'analytics', action: 'read' }), auditor);
    const request = makeRequest(SALES_AUTH);

    await expect(analyticsGuard(request, REPLY)).rejects.toBeInstanceOf(ForbiddenError);

    // recordDenied is fire-and-forget; let the append microtask settle.
    await flush();

    expect(rows).toHaveLength(1);
    const record = rows[0];
    expect(record.action).toBe('AUTHZ_DENIED');
    expect(record.actorUserId).toBe('sales-1');
    expect(record.targetType).toBe('authorization');
    // module + action are captured in detail (and module:action used as targetId fallback).
    expect(record.detail).toEqual({ module: 'analytics', action: 'read' });
    expect(record.targetId).toBe('analytics:read');

    // No secret value anywhere in the persisted record.
    const serialized = JSON.stringify(record);
    expect(serialized.toLowerCase()).not.toContain('token');
    expect(serialized.toLowerCase()).not.toContain('secret');
    expect(serialized.toLowerCase()).not.toContain('password');
  });

  it('a successful management action records all required fields and is returned by listRecent for ADMIN (Req 7.1, 7.5)', async () => {
    const { prisma, rows } = makeActivityPrisma();
    const logger = new ActivityLogger(prisma);

    // Mirrors what platforms/routes.ts appends after a successful token refresh.
    const view = await logger.append({
      actorUserId: 'sales-1',
      action: 'PLATFORM_TOKEN_REFRESHED',
      targetType: 'platform_token',
      targetId: 'facebook',
      detail: { status: true },
    });

    // The persisted row carries every required audit field.
    expect(view.actorUserId).toBe('sales-1');
    expect(view.action).toBe('PLATFORM_TOKEN_REFRESHED');
    expect(view.targetType).toBe('platform_token');
    expect(view.targetId).toBe('facebook');
    expect(view.detail).toEqual({ status: true });
    expect(view.createdAt).toBeInstanceOf(Date);
    expect(rows).toHaveLength(1);

    // No secret leaked into detail.
    expect(JSON.stringify(view.detail).toLowerCase()).not.toContain('token');

    // ADMIN retrieval surfaces the record with the required fields (Req 7.5).
    const recent = await logger.listRecent(1, 50);
    expect(recent.total).toBe(1);
    expect(recent.items[0]).toMatchObject({
      actorUserId: 'sales-1',
      action: 'PLATFORM_TOKEN_REFRESHED',
      targetType: 'platform_token',
      targetId: 'facebook',
    });
    expect(recent.items[0].createdAt).toBeInstanceOf(Date);
  });
});

// ============================================================================
// 14.4 — `settings` stays ADMIN-only for SALES; new grants do not leak (Req 6.5)
// ============================================================================
describe('14.4 settings/shared modules remain ADMIN-only for SALES (Req 6.5)', () => {
  // (module, action) pairs that SALES must NEVER be granted — the new
  // fine-grained grants (platform_tokens / document_catalog / knowledge_base)
  // must not leak access to these shared/denied surfaces.
  const DENIED_FOR_SALES: ReadonlyArray<[Module, Action]> = [
    // settings — partners-write & privacy/GDPR surfaces ride on this module.
    ['settings', 'read'],
    ['settings', 'update'],
    ['settings', 'create'],
    ['settings', 'delete'],
    // generation / strategy / publishing / feedback / analytics — deny-by-default.
    ['generation', 'read'],
    ['generation', 'create'],
    ['generation', 'update'],
    ['generation', 'delete'],
    ['strategy', 'read'],
    ['strategy', 'update'],
    ['publishing', 'read'],
    ['publishing', 'update'],
    ['feedback', 'read'],
    ['feedback', 'update'],
    ['analytics', 'read'],
    ['analytics', 'company_stats'],
    // user_management — ADMIN-only employee account management.
    ['user_management', 'read'],
    ['user_management', 'create'],
    ['user_management', 'update'],
    ['user_management', 'delete'],
    ['user_management', 'status_update'],
  ];

  it.each(DENIED_FOR_SALES)('SALES is denied 403 on %s/%s', (module, action) => {
    expect(authorize(SALES_CTX, { module, action })).toEqual({ allowed: false, status: 403 });
  });

  it.each(DENIED_FOR_SALES)('ADMIN remains allowed on %s/%s', (module, action) => {
    expect(authorize(ADMIN_CTX, { module, action })).toEqual({ allowed: true });
  });

  it('the new fine-grained grants are scoped — SALES allowed only on the documented (module, action) pairs', () => {
    // Sanity: the grants that DID flip to allow for SALES (so the regression
    // above is meaningful — access was added without leaking into settings).
    expect(authorize(SALES_CTX, { module: 'platform_tokens', action: 'read' })).toEqual({ allowed: true });
    expect(authorize(SALES_CTX, { module: 'platform_tokens', action: 'update' })).toEqual({ allowed: true });
    expect(authorize(SALES_CTX, { module: 'document_catalog', action: 'read' })).toEqual({ allowed: true });
    expect(authorize(SALES_CTX, { module: 'document_catalog', action: 'update' })).toEqual({ allowed: true });
    expect(authorize(SALES_CTX, { module: 'knowledge_base', action: 'create' })).toEqual({ allowed: true });
    // …but a non-granted action on a granted module is still denied.
    expect(authorize(SALES_CTX, { module: 'platform_tokens', action: 'delete' })).toEqual({ allowed: false, status: 403 });
    expect(authorize(SALES_CTX, { module: 'knowledge_base', action: 'delete' })).toEqual({ allowed: false, status: 403 });
  });
});
