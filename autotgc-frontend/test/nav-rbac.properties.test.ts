// Feature: frontend-ui-redesign, Property 1: Role-based navigation filtering is correct and safe
/**
 * Property 1 — Nav RBAC filtering. Validates Requirements 3.2, 3.5, 13.5.
 *
 * For all random NavGroup[] and role ∈ {ADMIN, SALES, null}, `filterNavGroups`:
 *   - keeps only items where `!item.roles || (role && item.roles.includes(role))`,
 *   - drops every group left with no visible items,
 *   - never surfaces an `roles=['ADMIN']` item to SALES,
 *   - does not mutate its input.
 *
 * Pure logic ⇒ property-based with ≥ 100 generated cases.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { filterNavGroups, isNavItemVisible } from '../src/lib/nav';
import type { NavGroup, NavItem, Role } from '../src/lib/nav';
import type { IconName } from '../src/components/Icon';

const ROLES: Role[] = ['ADMIN', 'SALES'];
const ICON: IconName = 'layout-dashboard';

const arbItem: fc.Arbitrary<NavItem> = fc.record({
  to: fc.string(),
  label: fc.string(),
  icon: fc.constant(ICON),
  // roles is optional: undefined (unrestricted) | a subset of the role set.
  roles: fc.option(fc.subarray(ROLES, { minLength: 0, maxLength: 2 }), {
    nil: undefined,
  }),
}) as fc.Arbitrary<NavItem>;

const arbGroup: fc.Arbitrary<NavGroup> = fc.record({
  title: fc.string(),
  items: fc.array(arbItem, { maxLength: 6 }),
});

const arbGroups = fc.array(arbGroup, { maxLength: 6 });
const arbRole = fc.constantFrom<Role | null>('ADMIN', 'SALES', null);

describe('Property 1: nav RBAC filtering', () => {
  it('keeps only visible items, drops empty groups, never leaks ADMIN to SALES, no mutation', () => {
    fc.assert(
      fc.property(arbGroups, arbRole, (groups, role) => {
        const snapshot = JSON.stringify(groups);
        const result = filterNavGroups(groups, role);

        // No group is empty after filtering.
        for (const group of result) {
          expect(group.items.length).toBeGreaterThan(0);
          // Every surviving item is genuinely visible to the role.
          for (const item of group.items) {
            expect(isNavItemVisible(item, role)).toBe(true);
            expect(!item.roles || (role !== null && item.roles.includes(role))).toBe(true);
          }
        }

        // Completeness: every visible item from a non-empty filtered group is kept.
        const keptCount = result.reduce((n, g) => n + g.items.length, 0);
        const expectedCount = groups.reduce(
          (n, g) => n + g.items.filter((i) => isNavItemVisible(i, role)).length,
          0,
        );
        expect(keptCount).toBe(expectedCount);

        // Consequence: an ADMIN-only item never appears for SALES.
        if (role === 'SALES') {
          for (const group of result) {
            for (const item of group.items) {
              expect(item.roles?.length === 1 && item.roles[0] === 'ADMIN').toBe(false);
            }
          }
        }

        // Input is not mutated.
        expect(JSON.stringify(groups)).toBe(snapshot);
      }),
      { numRuns: 200 },
    );
  });

  it('an explicit ADMIN-only item is hidden from SALES and null, shown to ADMIN', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (to, label) => {
        const adminItem: NavItem = { to, label, icon: ICON, roles: ['ADMIN'] };
        const groups: NavGroup[] = [{ title: 'g', items: [adminItem] }];
        expect(filterNavGroups(groups, 'ADMIN')).toHaveLength(1);
        expect(filterNavGroups(groups, 'SALES')).toHaveLength(0);
        expect(filterNavGroups(groups, null)).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
