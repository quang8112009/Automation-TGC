/**
 * Lead_Status_Machine — guarded transition function (Lead Management Req 5).
 */
export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'LOST';

export const ACTIVE_STATUSES: readonly LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED'];
export const TERMINAL_STATUSES: readonly LeadStatus[] = ['CONVERTED', 'LOST'];

/** All valid lead statuses (the Postgres enum domain). */
export const LEAD_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'LOST',
];

/** Type guard: is `v` one of the known lead statuses? */
export function isLeadStatus(v: unknown): v is LeadStatus {
  return typeof v === 'string' && (LEAD_STATUSES as readonly string[]).includes(v);
}

export const LEAD_TRANSITIONS: ReadonlyArray<readonly [LeadStatus, LeadStatus]> = [
  ['NEW', 'CONTACTED'],
  ['CONTACTED', 'QUALIFIED'],
  ['QUALIFIED', 'CONVERTED'],
  ['NEW', 'LOST'],
  ['CONTACTED', 'LOST'],
  ['QUALIFIED', 'LOST'],
];

export type LeadTransitionResult =
  | { ok: true; status: LeadStatus }
  | { ok: false; status: 409 };

export function leadTransition(current: LeadStatus, target: LeadStatus): LeadTransitionResult {
  const allowed = LEAD_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}
