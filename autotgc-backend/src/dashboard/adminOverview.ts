/**
 * Admin overview composition — pure, deterministic, framework-free logic for the
 * Operational Dashboard (admin-oversight-rbac-notifications Req 3.4, 3.5, 6.1, 6.3, 6.4, 6.7).
 *
 * Splits the "scope decision" (ADMIN company-wide vs SALES personal) and the
 * divide-by-zero-safe derived rate out of the route layer so they can be
 * property-tested in isolation. No Prisma/Fastify dependencies.
 */
import type { Role } from '../auth/jwt';

/** A value that may be unavailable because the underlying data is insufficient. */
export type Scoped<T> = T | 'INSUFFICIENT_DATA';

/** Company-wide KPIs (ADMIN scope only) — Req 6.1. */
export interface CompanyKpis {
  totalLeads: number;
  candidateFunnel: Record<string, number>; // keyed by CandidateStage
  pendingApprovals: number;
  conversionRate: Scoped<number>; // divide-by-0 -> 'INSUFFICIENT_DATA' (Req 6.7)
}

/** Personal KPIs (SALES scope) — assigned-only data (Req 3.5, 6.3). */
export interface PersonalKpis {
  totalLeads: number;
  leadsByStatus: Record<string, number>;
}

/** A single Recent_Activity_Feed entry (ADMIN only) — Req 6.6. */
export interface ActivityFeedItem {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
}

/** ADMIN dashboard payload: company stats + recent activity feed. */
export interface AdminOverviewPayload {
  scope: 'company';
  kpis: CompanyKpis;
  recentActivity: ActivityFeedItem[];
}

/** SALES dashboard payload: personal stats only — no feed, no company stats (Req 6.4). */
export interface SalesOverviewPayload {
  scope: 'personal';
  kpis: PersonalKpis;
}

/**
 * Safe derived rate (Req 6.7): when the denominator is 0 there is nothing to
 * divide by, so surface 'INSUFFICIENT_DATA' rather than emitting NaN/Infinity.
 * For any non-zero denominator the result is a finite number (never NaN/Infinity).
 */
export function safeRate(numerator: number, denominator: number): Scoped<number> {
  if (denominator === 0) return 'INSUFFICIENT_DATA';
  const rate = numerator / denominator;
  if (!Number.isFinite(rate)) return 'INSUFFICIENT_DATA';
  return rate;
}

/**
 * Choose the dashboard payload by role (pure, deterministic):
 *  - ADMIN  -> company payload WITH Recent_Activity_Feed (Req 6.1, 6.2).
 *  - SALES  -> personal payload, NO feed and NO company stats (Req 3.4, 3.5, 6.3, 6.4).
 */
export function composeOverview(
  role: Role,
  company: { kpis: CompanyKpis; recentActivity: ActivityFeedItem[] },
  personal: { kpis: PersonalKpis },
): AdminOverviewPayload | SalesOverviewPayload {
  if (role === 'ADMIN') {
    return {
      scope: 'company',
      kpis: company.kpis,
      recentActivity: company.recentActivity,
    };
  }
  return {
    scope: 'personal',
    kpis: personal.kpis,
  };
}
