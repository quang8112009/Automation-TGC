/**
 * Recruitment CRM pure validation/narrowing helpers (labor-export / XKLĐ).
 *
 * Enum membership checks for the Prisma recruitment enums plus small narrowing
 * helpers. Kept pure (no I/O) so they can be unit/property tested directly and
 * reused by both the services and the route layer. The string literal unions
 * here mirror the Prisma enums in schema.prisma exactly.
 */

export type RecruitmentMarketValue =
  | 'JAPAN' | 'GERMANY' | 'KOREA' | 'TAIWAN' | 'DOMESTIC' | 'OTHER';

export type VisaTypeValue =
  | 'TOKUTEI' | 'ENGINEER' | 'TRAINEE' | 'STUDENT'
  | 'GERMANY_PROGRAM' | 'KOREA_EPS' | 'DOMESTIC_JOB' | 'OTHER';

export type JobOrderStatusValue = 'OPEN' | 'PAUSED' | 'CLOSED' | 'FILLED';

export type CandidateStageValue =
  | 'NEW' | 'CONSULTING' | 'PROFILE_COLLECTED' | 'MATCHED'
  | 'INTERVIEW_SCHEDULED' | 'INTERVIEW_PASSED' | 'COE_VISA'
  | 'DEPARTED' | 'WITHDRAWN' | 'REJECTED';

export const RECRUITMENT_MARKETS: readonly RecruitmentMarketValue[] = [
  'JAPAN', 'GERMANY', 'KOREA', 'TAIWAN', 'DOMESTIC', 'OTHER',
];

export const VISA_TYPES: readonly VisaTypeValue[] = [
  'TOKUTEI', 'ENGINEER', 'TRAINEE', 'STUDENT',
  'GERMANY_PROGRAM', 'KOREA_EPS', 'DOMESTIC_JOB', 'OTHER',
];

export const JOB_ORDER_STATUSES: readonly JobOrderStatusValue[] = [
  'OPEN', 'PAUSED', 'CLOSED', 'FILLED',
];

export const CANDIDATE_STAGE_VALUES: readonly CandidateStageValue[] = [
  'NEW', 'CONSULTING', 'PROFILE_COLLECTED', 'MATCHED',
  'INTERVIEW_SCHEDULED', 'INTERVIEW_PASSED', 'COE_VISA',
  'DEPARTED', 'WITHDRAWN', 'REJECTED',
];

/** True when a string is undefined/null/whitespace-only. */
export function blank(v: string | null | undefined): boolean {
  return v === undefined || v === null || v.trim().length === 0;
}

export function isRecruitmentMarket(v: unknown): v is RecruitmentMarketValue {
  return typeof v === 'string' && (RECRUITMENT_MARKETS as readonly string[]).includes(v);
}

export function isVisaType(v: unknown): v is VisaTypeValue {
  return typeof v === 'string' && (VISA_TYPES as readonly string[]).includes(v);
}

export function isJobOrderStatus(v: unknown): v is JobOrderStatusValue {
  return typeof v === 'string' && (JOB_ORDER_STATUSES as readonly string[]).includes(v);
}

export function isCandidateStage(v: unknown): v is CandidateStageValue {
  return typeof v === 'string' && (CANDIDATE_STAGE_VALUES as readonly string[]).includes(v);
}
