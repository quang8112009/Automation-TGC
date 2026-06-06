/**
 * AuthorizationAuditor — best-effort audit sink for denied authorization
 * decisions (sales-access-restrictions Req 7.2, 7.3).
 *
 * Implements the `RbacAuditor` hook consumed by `rbacGuard` (http/authMiddleware).
 * It wraps `ActivityLogger` and records one `AUTHZ_DENIED` ActivityLog entry per
 * denied request. `recordDenied` is strictly fire-and-forget: it never awaits,
 * never throws, and swallows its own errors so a logging failure can never block
 * or fail the 403 response. The `detail` carries metadata only (module/action) —
 * never any secret value (Req 7.4).
 */
import type { Action, Module } from '../auth/rbac';
import type { RbacAuditor } from '../http/authMiddleware';
import type { ActivityLogger } from './activityLogger';

export class AuthorizationAuditor implements RbacAuditor {
  constructor(private readonly logger: ActivityLogger) {}

  recordDenied(input: {
    actorUserId: string;
    module: Module;
    action: Action;
    targetId?: string;
  }): void {
    // Fire-and-forget: do not await, and swallow any failure so the denied
    // response path is never blocked (Req 7.2, 7.3).
    void this.logger
      .append({
        actorUserId: input.actorUserId,
        action: 'AUTHZ_DENIED',
        targetType: 'authorization',
        targetId: input.targetId ?? `${input.module}:${input.action}`,
        detail: { module: input.module, action: input.action },
      })
      .catch(() => {});
  }
}
