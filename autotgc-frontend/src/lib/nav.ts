/**
 * Navigation model + pure role-filtering logic for the protected app shell.
 *
 * This module is intentionally framework-free (no React) so the role-filtering
 * rule can be imported and property-tested in isolation. `Layout.tsx` owns the
 * concrete `NAV_GROUPS` data and renders the result of `filterNavGroups`.
 *
 * Filtering rule (unchanged from the original inline `visibleGroups` logic):
 *   - an item is visible  ⇔  `!item.roles || (role && item.roles.includes(role))`
 *   - a group is visible  ⇔  it has at least one visible item
 */
import type { IconName } from '../components/Icon';
import type { Role } from './types';

export type { Role };

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** When set, only these roles see the item. */
  roles?: Role[];
}

export interface NavGroup {
  /** Vietnamese section heading. */
  title: string;
  items: NavItem[];
}

/** A single nav item is visible iff it is unrestricted or allows `role`. */
export function isNavItemVisible(item: NavItem, role: Role | null): boolean {
  return !item.roles || (role !== null && item.roles.includes(role));
}

/**
 * Filter grouped navigation by the current user role.
 *
 * Returns a new list of groups where each group keeps only the items visible to
 * `role`, and groups left with no visible items are dropped entirely. The input
 * is not mutated. Behavior is identical to the previous inline computation in
 * `Layout.tsx`: an item with `roles=['ADMIN']` never appears for `SALES`.
 */
export function filterNavGroups(groups: NavGroup[], role: Role | null): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isNavItemVisible(item, role)),
    }))
    .filter((group) => group.items.length > 0);
}
