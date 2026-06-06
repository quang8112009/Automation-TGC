/**
 * Essay_State_Machine — guarded transition function for the SOP/Essay/Motivation/CV
 * draft lifecycle (study-abroad-ai-advisor-suite, Req 8.1, 8.2, 8.5; Correctness Property 10).
 *
 * Mirrors the `reportStateMachine.ts` / `candidateStateMachine.ts` pattern: a pure,
 * framework-free guard that returns the target status for a valid transition and `409`
 * for any illegal pair. The REVIEW MODE lifecycle is:
 *   DRAFT -> IN_REVIEW -> APPROVED, with DRAFT/IN_REVIEW -> ARCHIVED.
 * `APPROVED` and `ARCHIVED` are terminal: they are never a valid transition source.
 *
 * `RoadmapNarrative` reuses this exact transition set (same `EssayStatus`) so the
 * REVIEW MODE state machine is not duplicated (Req 17.3).
 */
export type EssayStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ARCHIVED';

export const ESSAY_TRANSITIONS: ReadonlyArray<readonly [EssayStatus, EssayStatus]> = [
  ['DRAFT', 'IN_REVIEW'],
  ['IN_REVIEW', 'APPROVED'],
  ['DRAFT', 'ARCHIVED'],
  ['IN_REVIEW', 'ARCHIVED'],
];

export type EssayTransitionResult =
  | { ok: true; status: EssayStatus }
  | { ok: false; status: 409 };

/**
 * Pure + deterministic transition guard. Returns `{ ok: true, status: target }` if and
 * only if `(current, target)` is one of `ESSAY_TRANSITIONS`; every other pair returns
 * `{ ok: false, status: 409 }` and leaves the current status unchanged. (Req 8.1, 8.2, 8.5)
 */
export function essayTransition(current: EssayStatus, target: EssayStatus): EssayTransitionResult {
  const allowed = ESSAY_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}
