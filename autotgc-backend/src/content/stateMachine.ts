/**
 * Content_State_Machine — guarded transition function (Content Pipeline Req 11).
 */
export type ContentStatus =
  | 'DRAFT' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHING'
  | 'PUBLISHED' | 'REJECTED' | 'FAILED';

export const CONTENT_TRANSITIONS: ReadonlyArray<readonly [ContentStatus, ContentStatus]> = [
  ['DRAFT', 'APPROVED'],
  ['APPROVED', 'SCHEDULED'],
  ['SCHEDULED', 'PUBLISHING'],
  ['PUBLISHING', 'PUBLISHED'],
  ['DRAFT', 'REJECTED'],
  ['REJECTED', 'DRAFT'],
  ['PUBLISHING', 'FAILED'],
  ['FAILED', 'SCHEDULED'],
];

export type TransitionResult =
  | { ok: true; status: ContentStatus }
  | { ok: false; status: 409 };

export function contentTransition(current: ContentStatus, target: ContentStatus): TransitionResult {
  const allowed = CONTENT_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}
