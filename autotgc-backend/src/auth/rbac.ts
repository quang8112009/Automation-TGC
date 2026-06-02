/**
 * Authorization_Service — pure RBAC policy evaluation (Foundation Req 6).
 *
 * Single source of truth for authorization decisions (Req 10.1). Pure,
 * framework-free, deterministic (Req 10.2) — same input always yields the same
 * AuthzDecision so it is fully property-testable.
 */
import type { Role } from './jwt';

export type Action =
  | 'read' | 'create' | 'update' | 'delete' | 'status_update'
  | 'company_stats'; // NEW: read company-wide statistics (ADMIN-only). Not a write action.

export type Module =
  | 'strategy' | 'generation' | 'publishing' | 'analytics'
  | 'feedback' | 'lead_management' | 'settings' | 'dashboard'
  | 'user_management'; // NEW: employee account management (ADMIN-only).

export interface ResourceTarget {
  module: Module;
  action: Action;
  /** for assignable resources (leads): the owner this resource is assigned to */
  ownerUserId?: string;
}

export interface AuthContext {
  userId: string;
  role: Role;
}

export type AuthzDecision = { allowed: true } | { allowed: false; status: 403 };

const WRITE_ACTIONS: ReadonlySet<Action> = new Set(['create', 'update', 'delete', 'status_update']);

/**
 * Pure shared helper for any owner-scoped resource (lead/candidate/document/
 * report/stats). Returns true ONLY WHEN the owner matches the caller. When
 * `ownerUserId === undefined` (e.g. unassigned / not-found resource) this is
 * treated as NOT a match for SALES — the service layer still re-checks to close
 * any gap (Req 10.3, 10.7).
 */
export function isAssignedOwner(callerUserId: string, ownerUserId?: string): boolean {
  return ownerUserId !== undefined && ownerUserId === callerUserId;
}

export function authorize(ctx: AuthContext, target: ResourceTarget): AuthzDecision {
  // Req 4.1: ADMIN full read+write everywhere (incl. user_management, company_stats).
  if (ctx.role === 'ADMIN') {
    return { allowed: true };
  }

  // SALES policy (Req 3.1–3.3, 3.6–3.9, 5.9).
  if (ctx.role === 'SALES') {
    if (target.module === 'lead_management') {
      // assigned-only; read + update + status_update permitted, but not delete.
      if (target.action === 'delete') return { allowed: false, status: 403 }; // Req 3.2
      if (target.ownerUserId !== undefined && !isAssignedOwner(ctx.userId, target.ownerUserId)) {
        return { allowed: false, status: 403 }; // Req 3.1 non-assigned owner
      }
      if (target.action === 'read' || target.action === 'status_update' || target.action === 'update') {
        return { allowed: true }; // Req 3.3
      }
      return { allowed: false, status: 403 };
    }
    if (target.module === 'dashboard') {
      // company-wide stats are ADMIN-only (Req 3.6); writes denied (Req 3.8); other reads allowed (Req 3.7).
      if (target.action === 'company_stats') return { allowed: false, status: 403 };
      if (WRITE_ACTIONS.has(target.action)) return { allowed: false, status: 403 };
      return { allowed: true };
    }
    if (target.module === 'user_management') {
      // account management is ADMIN-only (Req 5.9).
      return { allowed: false, status: 403 };
    }
    // strategy/generation/publishing/analytics/feedback/settings -> 403 (Req 3.9)
    return { allowed: false, status: 403 };
  }

  return { allowed: false, status: 403 };
}
