/**
 * Report_State_Machine — guarded transition function (Company Reporting Req 3.2, 3.3).
 *
 * Mirrors the `insightStateMachine.ts` pattern: a pure, framework-free guard that
 * returns the target status for a valid transition and `409` for any illegal pair.
 * `INSUFFICIENT_DATA` is only an initial status for empty reports — it is never a
 * valid transition source or target.
 */
export type ReportStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ARCHIVED' | 'INSUFFICIENT_DATA';

export const REPORT_TRANSITIONS: ReadonlyArray<readonly [ReportStatus, ReportStatus]> = [
  ['DRAFT', 'IN_REVIEW'],
  ['IN_REVIEW', 'APPROVED'],
  ['DRAFT', 'ARCHIVED'],
  ['IN_REVIEW', 'ARCHIVED'],
];

export type ReportTransitionResult =
  | { ok: true; status: ReportStatus }
  | { ok: false; status: 409 };

export function reportTransition(current: ReportStatus, target: ReportStatus): ReportTransitionResult {
  const allowed = REPORT_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}
