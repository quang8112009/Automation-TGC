/**
 * Authorization_Service — pure RBAC policy evaluation (Foundation Req 6).
 */
import type { Role } from './jwt';

export type Action = 'read' | 'create' | 'update' | 'delete' | 'status_update';
export type Module =
  | 'strategy' | 'generation' | 'publishing' | 'analytics'
  | 'feedback' | 'lead_management' | 'settings' | 'dashboard';

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

export function authorize(ctx: AuthContext, target: ResourceTarget): AuthzDecision {
  // Req 6.2: ADMIN full read+write everywhere.
  if (ctx.role === 'ADMIN') {
    return { allowed: true };
  }

  // SALES policy (Req 6.3, 6.4, 6.5, 6.7, 6.8).
  if (ctx.role === 'SALES') {
    if (target.module === 'lead_management') {
      // assigned-only; read + status_update permitted, but not delete.
      if (target.action === 'delete') return { allowed: false, status: 403 };
      if (target.ownerUserId !== undefined && target.ownerUserId !== ctx.userId) {
        return { allowed: false, status: 403 }; // Req 6.7 non-assigned
      }
      if (target.action === 'read' || target.action === 'status_update' || target.action === 'update') {
        return { allowed: true };
      }
      return { allowed: false, status: 403 };
    }
    if (target.module === 'dashboard') {
      // read-only (Req 6.4); writes denied (Req 6.8)
      if (WRITE_ACTIONS.has(target.action)) return { allowed: false, status: 403 };
      return { allowed: true };
    }
    // strategy/generation/publishing/analytics/feedback/settings -> 403 (Req 6.5)
    return { allowed: false, status: 403 };
  }

  return { allowed: false, status: 403 };
}
