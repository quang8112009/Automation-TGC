/**
 * Property-based tests for the sales-access-restrictions spec.
 *
 * Each test maps 1:1 to a Correctness Property from
 * `.kiro/specs/sales-access-restrictions/design.md` and is tagged
 *   // Feature: sales-access-restrictions, Property {n}: {short description}
 *
 * The core under test is the pure RBAC policy in `src/auth/rbac.ts`
 * (`authorize`, `isAssignedOwner`). For Property 4 (collection scoping) the
 * pure filter is modelled in-test via a small predicate that mirrors the
 * service-layer `where.assignedTo === userId` scoping for SALES.
 *
 * Conventions follow the existing suites (foundation.properties.test.ts):
 * fast-check generators with `numRuns >= 100`, pure functions tested directly.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { authorize, isAssignedOwner } from '../src/auth/rbac';
import type { Action, Module, AuthContext, ResourceTarget } from '../src/auth/rbac';
import type { Role } from '../src/auth/jwt';

// ---------------------------------------------------------------------------
// Shared generators
// ---------------------------------------------------------------------------

const ALL_MODULES: Module[] = [
  'strategy', 'generation', 'publishing', 'analytics',
  'feedback', 'lead_management', 'settings', 'dashboard',
  'user_management', 'platform_tokens', 'document_catalog', 'knowledge_base',
];

const ALL_ACTIONS: Action[] = [
  'read', 'create', 'update', 'delete', 'status_update', 'company_stats',
];

const moduleArb = fc.constantFrom(...ALL_MODULES);
const actionArb = fc.constantFrom(...ALL_ACTIONS);
const roleArb = fc.constantFrom<Role>('ADMIN', 'SALES');
const userIdArb = fc.string();
/** ownerUserId may be undefined (unassigned / not-found) or any string. */
const ownerArb = fc.option(fc.string(), { nil: undefined });

/**
 * Reference allow-set predicate for SALES, derived directly from the design
 * decision table. Returns true IFF SALES should be granted (module, action),
 * given the caller id and the resource owner. This is the independent oracle
 * the implementation must match.
 */
function salesShouldAllow(
  callerUserId: string,
  module: Module,
  action: Action,
  ownerUserId: string | undefined,
): boolean {
  // Fine-grained configuration/reference surfaces — explicit allow-list.
  if (module === 'platform_tokens') return action === 'read' || action === 'update';
  if (module === 'document_catalog') return action === 'read' || action === 'update';
  if (module === 'knowledge_base') {
    return action === 'read' || action === 'create' || action === 'update';
  }

  // lead_management — assigned-only; read/update/status_update only, never delete/create.
  if (module === 'lead_management') {
    if (action === 'delete' || action === 'create') return false;
    if (action !== 'read' && action !== 'update' && action !== 'status_update') return false;
    // owner undefined is allowed at the policy layer (service re-scopes collections);
    // a defined owner must match the caller.
    return ownerUserId === undefined || ownerUserId === callerUserId;
  }

  // dashboard — personal reads only; company_stats and writes denied.
  if (module === 'dashboard') {
    return action === 'read';
  }

  // Everything else (settings, generation, strategy, publishing, analytics,
  // feedback, user_management) → deny by default.
  return false;
}

// ===========================================================================
// Property 1: SALES decision table — allow exactly equals the allow-set
// ===========================================================================

describe('sales-access-restrictions: SALES decision table', () => {
  // Feature: sales-access-restrictions, Property 1: SALES allow == reference allow-set, deny otherwise (403)
  it('Property 1: authorize(SALES) allowed iff target matches the reference allow-set', () => {
    fc.assert(
      fc.property(userIdArb, moduleArb, actionArb, ownerArb, (caller, module, action, owner) => {
        const ctx: AuthContext = { userId: caller, role: 'SALES' };
        const target: ResourceTarget = { module, action, ownerUserId: owner };
        const decision = authorize(ctx, target);
        const expected = salesShouldAllow(caller, module, action, owner);
        expect(decision.allowed).toBe(expected);
        if (!decision.allowed) expect(decision.status).toBe(403);
      }),
      { numRuns: 500 },
    );
  });
});

// ===========================================================================
// Property 2: ADMIN is always allowed
// ===========================================================================

describe('sales-access-restrictions: ADMIN always allowed', () => {
  // Feature: sales-access-restrictions, Property 2: authorize(ADMIN) is always allowed
  it('Property 2: authorize(ADMIN) allowed for every (module, action, ownerUserId)', () => {
    fc.assert(
      fc.property(userIdArb, moduleArb, actionArb, ownerArb, (caller, module, action, owner) => {
        const ctx: AuthContext = { userId: caller, role: 'ADMIN' };
        const decision = authorize(ctx, { module, action, ownerUserId: owner });
        expect(decision.allowed).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// Property 3: owner-match for lead_management (read/update/status_update)
// ===========================================================================

describe('sales-access-restrictions: lead_management owner-match', () => {
  const leadActionArb = fc.constantFrom<Action>('read', 'update', 'status_update');

  // Feature: sales-access-restrictions, Property 3: lead_management allowed iff owner undefined or isAssignedOwner
  it('Property 3: SALES lead_management allowed iff isAssignedOwner OR owner undefined', () => {
    fc.assert(
      fc.property(userIdArb, ownerArb, leadActionArb, (caller, owner, action) => {
        const ctx: AuthContext = { userId: caller, role: 'SALES' };
        const decision = authorize(ctx, { module: 'lead_management', action, ownerUserId: owner });
        const expected = owner === undefined || isAssignedOwner(caller, owner);
        expect(decision.allowed).toBe(expected);
        if (!decision.allowed) expect(decision.status).toBe(403);
      }),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// Property 4: collection scoping — SALES results are a subset of the owned set
// ===========================================================================

describe('sales-access-restrictions: collection scoping', () => {
  interface Resource {
    id: number;
    assignedTo: string | undefined;
  }

  /**
   * Pure model of the service-layer `where.assignedTo === userId` scoping for
   * SALES. Mirrors the production filter and relies on the same ownership
   * semantics as `isAssignedOwner` (undefined owner never matches).
   */
  function scopeForSales(resources: Resource[], salesId: string): Resource[] {
    return resources.filter((r) => isAssignedOwner(salesId, r.assignedTo));
  }

  const resourceArrayArb = fc.array(
    fc.record({
      id: fc.integer(),
      assignedTo: fc.option(fc.string(), { nil: undefined }),
    }),
    { maxLength: 30 },
  );

  // Feature: sales-access-restrictions, Property 4: SALES collection result is exactly the owned subset
  it('Property 4: scoped result contains only owned resources, never others/undefined; empty when none owned', () => {
    fc.assert(
      fc.property(resourceArrayArb, userIdArb, (resources, salesId) => {
        const scoped = scopeForSales(resources, salesId);

        // Every included item is owned by salesId.
        for (const r of scoped) {
          expect(r.assignedTo).toBe(salesId);
        }
        // No item with a different or undefined owner is included.
        for (const r of resources) {
          if (r.assignedTo !== salesId) {
            expect(scoped).not.toContain(r);
          }
        }
        // Empty when none owned.
        const anyOwned = resources.some((r) => r.assignedTo === salesId);
        if (!anyOwned) expect(scoped).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// Property 5: authorize is deterministic
// ===========================================================================

describe('sales-access-restrictions: determinism', () => {
  const ctxArb = fc.record({ userId: userIdArb, role: roleArb });
  const targetArb = fc.record({
    module: moduleArb,
    action: actionArb,
    ownerUserId: ownerArb,
  });

  // Feature: sales-access-restrictions, Property 5: two consecutive authorize() calls deep-equal
  it('Property 5: authorize(ctx, target) returns deep-equal decisions on repeated calls', () => {
    fc.assert(
      fc.property(ctxArb, targetArb, (ctx, target) => {
        const first = authorize(ctx, target);
        const second = authorize(ctx, target);
        expect(first).toEqual(second);
      }),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// Property 6: undefined owner never matches (isAssignedOwner helper)
// ===========================================================================

describe('sales-access-restrictions: isAssignedOwner helper', () => {
  // Feature: sales-access-restrictions, Property 6: undefined owner never matches; defined owner matches iff equal
  it('Property 6: isAssignedOwner(caller, undefined)===false; defined owner === (owner===caller)', () => {
    fc.assert(
      fc.property(userIdArb, ownerArb, (caller, owner) => {
        if (owner === undefined) {
          expect(isAssignedOwner(caller, undefined)).toBe(false);
        } else {
          expect(isAssignedOwner(caller, owner)).toBe(owner === caller);
        }
      }),
      { numRuns: 300 },
    );
  });
});
