/**
 * Recruitment-CRM constants + Vietnamese labels shared across the job-order,
 * candidate, and AI pages. Enum values mirror the backend (schema.prisma);
 * labels are the product language (Vietnamese).
 */
import type {
  CandidateStage,
  JapaneseLevel,
  JobOrderStatus,
  RecruitmentMarket,
  VisaType,
} from './types';

export const MARKETS: RecruitmentMarket[] = [
  'JAPAN',
  'GERMANY',
  'KOREA',
  'TAIWAN',
  'DOMESTIC',
  'OTHER',
];

export const MARKET_LABELS: Record<RecruitmentMarket, string> = {
  JAPAN: 'Nhật Bản',
  GERMANY: 'Đức',
  KOREA: 'Hàn Quốc',
  TAIWAN: 'Đài Loan',
  DOMESTIC: 'Trong nước',
  OTHER: 'Khác',
};

export const VISA_TYPES: VisaType[] = [
  'TOKUTEI',
  'ENGINEER',
  'TRAINEE',
  'STUDENT',
  'GERMANY_PROGRAM',
  'KOREA_EPS',
  'DOMESTIC_JOB',
  'OTHER',
];

export const VISA_TYPE_LABELS: Record<VisaType, string> = {
  TOKUTEI: 'Kỹ năng đặc định (SSW)',
  ENGINEER: 'Kỹ sư / Nhân viên',
  TRAINEE: 'Thực tập sinh (TTS)',
  STUDENT: 'Du học / Sinh viên',
  GERMANY_PROGRAM: 'Chương trình Đức',
  KOREA_EPS: 'Hàn Quốc (EPS)',
  DOMESTIC_JOB: 'Việc làm trong nước',
  OTHER: 'Khác',
};

export const JOB_ORDER_STATUSES: JobOrderStatus[] = ['OPEN', 'PAUSED', 'CLOSED', 'FILLED'];

export const JOB_ORDER_STATUS_LABELS: Record<JobOrderStatus, string> = {
  OPEN: 'Đang tuyển',
  PAUSED: 'Tạm dừng',
  CLOSED: 'Đã đóng',
  FILLED: 'Đã đủ',
};

export const CANDIDATE_STAGES: CandidateStage[] = [
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

export const CANDIDATE_STAGE_LABELS: Record<CandidateStage, string> = {
  NEW: 'Mới',
  CONSULTING: 'Đang tư vấn',
  PROFILE_COLLECTED: 'Đã thu hồ sơ',
  MATCHED: 'Đã ghép đơn',
  INTERVIEW_SCHEDULED: 'Đã hẹn phỏng vấn',
  INTERVIEW_PASSED: 'Đậu phỏng vấn',
  COE_VISA: 'COE / Visa',
  DEPARTED: 'Đã xuất cảnh',
  WITHDRAWN: 'Rút hồ sơ',
  REJECTED: 'Trượt / Từ chối',
};

/** Badge color class per candidate stage (uses the existing badge-* palette). */
export const CANDIDATE_STAGE_BADGE: Record<CandidateStage, string> = {
  NEW: 'badge-blue',
  CONSULTING: 'badge-blue',
  PROFILE_COLLECTED: 'badge-yellow',
  MATCHED: 'badge-yellow',
  INTERVIEW_SCHEDULED: 'badge-yellow',
  INTERVIEW_PASSED: 'badge-green',
  COE_VISA: 'badge-green',
  DEPARTED: 'badge-green',
  WITHDRAWN: 'badge-gray',
  REJECTED: 'badge-red',
};

export const JOB_ORDER_STATUS_BADGE: Record<JobOrderStatus, string> = {
  OPEN: 'badge-green',
  PAUSED: 'badge-yellow',
  CLOSED: 'badge-gray',
  FILLED: 'badge-blue',
};

export const JAPANESE_LEVELS: JapaneseLevel[] = ['NONE', 'N5', 'N4', 'N3', 'N2', 'N1'];

export const GENDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '— Chưa rõ —' },
  { value: 'MALE', label: 'Nam' },
  { value: 'FEMALE', label: 'Nữ' },
];

/** Job-order gender requirement options (ANY allowed for orders). */
export const JOB_GENDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'ANY', label: 'Không yêu cầu' },
  { value: 'MALE', label: 'Nam' },
  { value: 'FEMALE', label: 'Nữ' },
];

export function marketLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return MARKET_LABELS[value as RecruitmentMarket] ?? value;
}

export function visaTypeLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return VISA_TYPE_LABELS[value as VisaType] ?? value;
}

export function jobOrderStatusLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return JOB_ORDER_STATUS_LABELS[value as JobOrderStatus] ?? value;
}

export function candidateStageLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return CANDIDATE_STAGE_LABELS[value as CandidateStage] ?? value;
}

/**
 * Allowed candidate stage transitions — mirrors the backend
 * candidateStateMachine so the UI only offers legal next stages (the server is
 * still authoritative and returns 409 on an illegal transition).
 */
const NON_TERMINAL_STAGES: CandidateStage[] = [
  'NEW',
  'CONSULTING',
  'PROFILE_COLLECTED',
  'MATCHED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_PASSED',
  'COE_VISA',
];

const FORWARD_AND_REWORK_EDGES: Array<[CandidateStage, CandidateStage]> = [
  ['NEW', 'CONSULTING'],
  ['CONSULTING', 'PROFILE_COLLECTED'],
  ['PROFILE_COLLECTED', 'MATCHED'],
  ['MATCHED', 'INTERVIEW_SCHEDULED'],
  ['INTERVIEW_SCHEDULED', 'INTERVIEW_PASSED'],
  ['INTERVIEW_PASSED', 'COE_VISA'],
  ['COE_VISA', 'DEPARTED'],
  ['MATCHED', 'CONSULTING'],
  ['INTERVIEW_SCHEDULED', 'MATCHED'],
];

/** Return the set of stages reachable from `current` via a single transition. */
export function allowedNextStages(current: CandidateStage): CandidateStage[] {
  const next = new Set<CandidateStage>();
  for (const [from, to] of FORWARD_AND_REWORK_EDGES) {
    if (from === current) next.add(to);
  }
  // From any non-terminal stage a candidate may be WITHDRAWN or REJECTED.
  if (NON_TERMINAL_STAGES.includes(current)) {
    next.add('WITHDRAWN');
    next.add('REJECTED');
  }
  return CANDIDATE_STAGES.filter((s) => next.has(s));
}
