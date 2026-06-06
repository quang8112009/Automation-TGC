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
  | 'user_management' // NEW: employee account management (ADMIN-only).
  // NEW — fine-grained SALES configuration/reference surfaces, split out from
  // the shared `settings`/`generation` modules to avoid privilege escalation.
  | 'platform_tokens' | 'document_catalog' | 'knowledge_base';

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
 * Allow-list of (module, action) pairs granted to SALES beyond the
 * lead_management/dashboard branches. Splitting these into fine-grained modules
 * (instead of flattening the shared `settings`/`generation` modules) keeps
 * partner-write and privacy/GDPR-erasure ADMIN-only (Req 6 no-privilege-escalation).
 */
const SALES_CONFIG_GRANTS: Readonly<Record<string, ReadonlySet<Action>>> = {
  platform_tokens: new Set(['read', 'update']),            // Req 1.1, 1.2
  document_catalog: new Set(['read', 'update']),           // Req 1.4, 1.5
  knowledge_base: new Set(['read', 'create', 'update']),   // Req 1.6–1.9 (deactivate = update active:false)
};

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

  // SALES policy (Req 1, 2, 3, 5, 6).
  if (ctx.role === 'SALES') {
    // (1) Fine-grained configuration/reference surfaces — explicit allow-list (Req 1.1–1.9).
    const granted = SALES_CONFIG_GRANTS[target.module];
    if (granted) {
      return granted.has(target.action) ? { allowed: true } : { allowed: false, status: 403 };
    }

    if (target.module === 'lead_management') {
      // assigned-only; read + update + status_update permitted, but not delete.
      if (target.action === 'delete') return { allowed: false, status: 403 }; // Req 2.5
      if (target.ownerUserId !== undefined && !isAssignedOwner(ctx.userId, target.ownerUserId)) {
        return { allowed: false, status: 403 }; // Req 2.3, 3.4 non-assigned owner
      }
      if (target.action === 'read' || target.action === 'status_update' || target.action === 'update') {
        return { allowed: true }; // Req 3.7
      }
      return { allowed: false, status: 403 }; // create → 403
    }
    if (target.module === 'dashboard') {
      // company-wide stats are ADMIN-only (Req 6.4); writes denied (Req 6.3); other reads allowed (Req 6.6).
      if (target.action === 'company_stats') return { allowed: false, status: 403 };
      if (WRITE_ACTIONS.has(target.action)) return { allowed: false, status: 403 };
      return { allowed: true };
    }
    // settings/generation/strategy/publishing/analytics/feedback/user_management -> 403
    // (Req 5.1, 5.3, 6.1, 6.2, 6.5) — deny-by-default.
    return { allowed: false, status: 403 };
  }

  return { allowed: false, status: 403 }; // unknown role → fail-closed deny.
}
