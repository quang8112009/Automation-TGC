/**
 * Insight_State_Machine — guarded transition function (Analytics Req 15).
 */
export type InsightStatus = 'NEW' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

export const INSIGHT_TRANSITIONS: ReadonlyArray<readonly [InsightStatus, InsightStatus]> = [
  ['NEW', 'PENDING_REVIEW'],
  ['PENDING_REVIEW', 'APPROVED'],
  ['PENDING_REVIEW', 'REJECTED'],
];

export type InsightTransitionResult =
  | { ok: true; status: InsightStatus }
  | { ok: false; status: 409 };

export function insightTransition(current: InsightStatus, target: InsightStatus): InsightTransitionResult {
  const allowed = INSIGHT_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}
