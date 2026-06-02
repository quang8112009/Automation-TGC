/**
 * Visa_Catalog — pure, per-country smart-checklist definitions + a deadline
 * calculator. Framework-free so the checklist generation is deterministic and
 * property-testable; the service persists the produced tasks as VisaTask rows.
 *
 * Each country maps to an ordered set of task templates (documents + logistics
 * categories). Deadlines are derived from a target intake date by subtracting a
 * per-task lead time, never producing a date after the intake.
 */

export type VisaTaskCategory =
  | 'DOCUMENT'
  | 'INSURANCE'
  | 'FLIGHT'
  | 'HOUSING'
  | 'PICKUP'
  | 'FEE'
  | 'OTHER';

export interface VisaTaskTemplate {
  code: string;
  label: string;
  category: VisaTaskCategory;
  required: boolean;
  /** Days BEFORE the target intake date this task should be completed by. */
  leadDays: number;
}

/** Common base tasks shared by all study/work visa countries. */
const BASE_TASKS: readonly VisaTaskTemplate[] = [
  { code: 'PASSPORT', label: 'Hộ chiếu còn hạn (tối thiểu 6 tháng)', category: 'DOCUMENT', required: true, leadDays: 120 },
  { code: 'PHOTOS', label: 'Ảnh thẻ theo chuẩn visa', category: 'DOCUMENT', required: true, leadDays: 110 },
  { code: 'APPLICATION_FORM', label: 'Đơn xin visa đã điền đầy đủ', category: 'DOCUMENT', required: true, leadDays: 90 },
  { code: 'FINANCIAL_PROOF', label: 'Chứng minh tài chính', category: 'DOCUMENT', required: true, leadDays: 80 },
  { code: 'VISA_FEE', label: 'Đóng lệ phí visa', category: 'FEE', required: true, leadDays: 60 },
  { code: 'FLIGHT_BOOKING', label: 'Đặt vé máy bay', category: 'FLIGHT', required: true, leadDays: 21 },
  { code: 'AIRPORT_PICKUP', label: 'Sắp xếp dịch vụ đưa đón sân bay', category: 'PICKUP', required: false, leadDays: 14 },
  { code: 'HOUSING', label: 'Chuẩn bị chỗ ở (homestay/ký túc xá)', category: 'HOUSING', required: true, leadDays: 30 },
];

/**
 * Country-specific tasks layered on top of BASE_TASKS. Keyed by uppercase
 * country code. Unknown countries get the base set (+ generic health check).
 */
const COUNTRY_TASKS: Readonly<Record<string, readonly VisaTaskTemplate[]>> = {
  AUSTRALIA: [
    { code: 'COE', label: 'Confirmation of Enrolment (CoE) từ trường', category: 'DOCUMENT', required: true, leadDays: 100 },
    { code: 'GTE_STATEMENT', label: 'Genuine Temporary Entrant (GTE) statement', category: 'DOCUMENT', required: true, leadDays: 85 },
    { code: 'OSHC', label: 'Bảo hiểm y tế sinh viên OSHC', category: 'INSURANCE', required: true, leadDays: 75 },
    { code: 'ENGLISH_TEST', label: 'Chứng chỉ tiếng Anh (IELTS/PTE)', category: 'DOCUMENT', required: true, leadDays: 95 },
    { code: 'HEALTH_EXAM', label: 'Khám sức khỏe tại cơ sở được chỉ định', category: 'DOCUMENT', required: true, leadDays: 70 },
  ],
  USA: [
    { code: 'I20', label: 'Form I-20 từ trường', category: 'DOCUMENT', required: true, leadDays: 100 },
    { code: 'SEVIS_FEE', label: 'Đóng phí SEVIS I-901', category: 'FEE', required: true, leadDays: 85 },
    { code: 'DS160', label: 'Hoàn thành đơn DS-160', category: 'DOCUMENT', required: true, leadDays: 80 },
    { code: 'VISA_INTERVIEW', label: 'Đặt lịch & phỏng vấn visa tại Lãnh sự quán', category: 'DOCUMENT', required: true, leadDays: 60 },
    { code: 'INSURANCE', label: 'Bảo hiểm y tế du học sinh', category: 'INSURANCE', required: true, leadDays: 40 },
    { code: 'ENGLISH_TEST', label: 'Chứng chỉ tiếng Anh (TOEFL/IELTS)', category: 'DOCUMENT', required: true, leadDays: 95 },
  ],
  CANADA: [
    { code: 'LOA', label: 'Letter of Acceptance (LOA) từ trường (DLI)', category: 'DOCUMENT', required: true, leadDays: 100 },
    { code: 'GIC', label: 'Guaranteed Investment Certificate (GIC)', category: 'DOCUMENT', required: true, leadDays: 80 },
    { code: 'BIOMETRICS', label: 'Lấy sinh trắc học (biometrics)', category: 'DOCUMENT', required: true, leadDays: 60 },
    { code: 'MEDICAL_EXAM', label: 'Khám sức khỏe (panel physician)', category: 'DOCUMENT', required: true, leadDays: 70 },
    { code: 'INSURANCE', label: 'Bảo hiểm y tế tỉnh bang/tư nhân', category: 'INSURANCE', required: true, leadDays: 40 },
    { code: 'ENGLISH_TEST', label: 'Chứng chỉ tiếng Anh (IELTS)', category: 'DOCUMENT', required: true, leadDays: 95 },
  ],
  UK: [
    { code: 'CAS', label: 'Confirmation of Acceptance for Studies (CAS)', category: 'DOCUMENT', required: true, leadDays: 100 },
    { code: 'IHS', label: 'Đóng phí Immigration Health Surcharge (IHS)', category: 'INSURANCE', required: true, leadDays: 75 },
    { code: 'TB_TEST', label: 'Xét nghiệm lao (TB test)', category: 'DOCUMENT', required: true, leadDays: 70 },
    { code: 'ENGLISH_TEST', label: 'Chứng chỉ tiếng Anh (IELTS UKVI)', category: 'DOCUMENT', required: true, leadDays: 95 },
    { code: 'FINANCIAL_28DAYS', label: 'Sao kê tài chính đủ 28 ngày', category: 'DOCUMENT', required: true, leadDays: 65 },
  ],
  JAPAN: [
    { code: 'COE_JP', label: 'Giấy chứng nhận tư cách lưu trú (COE)', category: 'DOCUMENT', required: true, leadDays: 100 },
    { code: 'JLPT_CERT', label: 'Chứng chỉ tiếng Nhật (JLPT/NAT)', category: 'DOCUMENT', required: true, leadDays: 95 },
    { code: 'HEALTH_EXAM', label: 'Khám sức khỏe theo mẫu', category: 'DOCUMENT', required: true, leadDays: 70 },
    { code: 'INSURANCE', label: 'Bảo hiểm (kokumin kenko hoken khi nhập cảnh)', category: 'INSURANCE', required: false, leadDays: 20 },
  ],
};

/** Generic extra task for countries without a specific template. */
const GENERIC_EXTRA: readonly VisaTaskTemplate[] = [
  { code: 'HEALTH_EXAM', label: 'Khám sức khỏe', category: 'DOCUMENT', required: true, leadDays: 70 },
  { code: 'INSURANCE', label: 'Bảo hiểm y tế phù hợp', category: 'INSURANCE', required: true, leadDays: 40 },
];

/** Normalize a country code to the catalog key. */
export function normalizeCountry(country: string | null | undefined): string {
  return (country ?? '').trim().toUpperCase();
}

/**
 * Build the ordered task template list for a country (base + country-specific,
 * de-duplicated by code, country-specific overriding base for the same code).
 */
export function checklistFor(country: string | null | undefined): VisaTaskTemplate[] {
  const key = normalizeCountry(country);
  const specific = COUNTRY_TASKS[key] ?? GENERIC_EXTRA;
  const byCode = new Map<string, VisaTaskTemplate>();
  for (const t of BASE_TASKS) byCode.set(t.code, t);
  for (const t of specific) byCode.set(t.code, t); // override/add
  // Sort by leadDays desc (earliest deadlines first) then code for stability.
  return [...byCode.values()].sort((a, b) => (b.leadDays - a.leadDays) || (a.code < b.code ? -1 : 1));
}

/** True iff the catalog has a country-specific template (vs the generic set). */
export function hasCountryTemplate(country: string | null | undefined): boolean {
  return COUNTRY_TASKS[normalizeCountry(country)] !== undefined;
}

export interface DatedVisaTask extends VisaTaskTemplate {
  /** Computed due date, or null when no target intake date was provided. */
  dueAt: Date | null;
}

/**
 * Compute a due date for each task by subtracting `leadDays` from the target
 * intake date. Never returns a date after the intake; a null target yields null
 * due dates (deadlines unknown until an intake date is set).
 */
export function withDeadlines(
  templates: readonly VisaTaskTemplate[],
  targetIntakeDate: Date | null,
): DatedVisaTask[] {
  return templates.map((t) => {
    if (!targetIntakeDate || Number.isNaN(targetIntakeDate.getTime())) {
      return { ...t, dueAt: null };
    }
    const due = new Date(targetIntakeDate.getTime() - t.leadDays * 86_400_000);
    return { ...t, dueAt: due };
  });
}
