/**
 * Candidate_Stage_Machine — guarded transition function over the labor-export
 * (XKLĐ) recruitment pipeline.
 *
 * Forward lifecycle:
 *   NEW -> CONSULTING -> PROFILE_COLLECTED -> MATCHED -> INTERVIEW_SCHEDULED
 *       -> INTERVIEW_PASSED -> COE_VISA -> DEPARTED
 *
 * Re-work (fallback) edges when a candidate slips back a step:
 *   MATCHED -> CONSULTING, INTERVIEW_SCHEDULED -> MATCHED
 *
 * From any non-terminal stage a candidate may be WITHDRAWN (rút hồ sơ) or
 * REJECTED (trượt). DEPARTED, WITHDRAWN, REJECTED are terminal: they are never
 * a transition source. Modeled the same way as the Lead/Content state machines.
 */
export type CandidateStage =
  | 'NEW'
  | 'CONSULTING'
  | 'PROFILE_COLLECTED'
  | 'MATCHED'
  | 'INTERVIEW_SCHEDULED'
  | 'INTERVIEW_PASSED'
  | 'COE_VISA'
  | 'DEPARTED'
  | 'WITHDRAWN'
  | 'REJECTED';

export const CANDIDATE_STAGES: readonly CandidateStage[] = [
  'NEW',
  'CONSULTING',
  'PROFILE_COLLECTED',
  'MATCHED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_PASSED',
  'COE_VISA',
  'DEPARTED',
  'WITHDRAWN',
  'REJECTED',
];

/** Terminal stages: never a transition source. */
export const TERMINAL_STAGES: readonly CandidateStage[] = ['DEPARTED', 'WITHDRAWN', 'REJECTED'];

/** Non-terminal stages, each of which may also drop to WITHDRAWN / REJECTED. */
const NON_TERMINAL_STAGES: readonly CandidateStage[] = [
  'NEW',
  'CONSULTING',
  'PROFILE_COLLECTED',
  'MATCHED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_PASSED',
  'COE_VISA',
];

const FORWARD_AND_REWORK_EDGES: ReadonlyArray<readonly [CandidateStage, CandidateStage]> = [
  // forward lifecycle
  ['NEW', 'CONSULTING'],
  ['CONSULTING', 'PROFILE_COLLECTED'],
  ['PROFILE_COLLECTED', 'MATCHED'],
  ['MATCHED', 'INTERVIEW_SCHEDULED'],
  ['INTERVIEW_SCHEDULED', 'INTERVIEW_PASSED'],
  ['INTERVIEW_PASSED', 'COE_VISA'],
  ['COE_VISA', 'DEPARTED'],
  // re-work / fallback edges
  ['MATCHED', 'CONSULTING'],
  ['INTERVIEW_SCHEDULED', 'MATCHED'],
];

/**
 * The full allowed transition list: forward + re-work edges, plus every
 * non-terminal -> WITHDRAWN and non-terminal -> REJECTED drop-out edge.
 */
export const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [CandidateStage, CandidateStage]> = [
  ...FORWARD_AND_REWORK_EDGES,
  ...NON_TERMINAL_STAGES.map((s): readonly [CandidateStage, CandidateStage] => [s, 'WITHDRAWN']),
  ...NON_TERMINAL_STAGES.map((s): readonly [CandidateStage, CandidateStage] => [s, 'REJECTED']),
];

export type CandidateTransitionResult =
  | { ok: true; status: CandidateStage }
  | { ok: false; status: 409 };

export function candidateTransition(
  current: CandidateStage,
  target: CandidateStage,
): CandidateTransitionResult {
  const allowed = ALLOWED_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}
