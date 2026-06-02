/**
 * Default per-market document catalog for candidate document checklists
 * (Requirements 12.1, 12.3).
 *
 * Pure, framework-free logic (no Prisma/Fastify). The catalog mirrors the
 * canonical `RecruitmentMarket` codes (JAPAN | KOREA | GERMANY | TAIWAN |
 * DOMESTIC | OTHER) from `prisma/schema.prisma`. Each market maps to a sensible
 * default set of documents with a stable `type` code and a Vietnamese `label`.
 *
 * `defaultDocsForMarket` resolves the default set for a given market code,
 * falling back to the `OTHER` set for null / undefined / unknown markets.
 */

/** Submission status of a single checklist item. */
export type DocSubmissionStatus = 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

/** Origin of a checklist item: seeded from the catalog, or added ad-hoc. */
export type DocSource = 'DEFAULT' | 'CUSTOM';

/** A single default document type definition for a market. */
export interface DocTypeDef {
  /** Stable, machine-readable document-type code (e.g. `PASSPORT`). */
  type: string;
  /** Human-facing Vietnamese label. */
  label: string;
  /** Whether the document is mandatory for the market. */
  required: boolean;
}

/** Canonical fallback market code used when a market is null/unknown. */
const FALLBACK_MARKET = 'OTHER';

/**
 * Default document sets keyed by `RecruitmentMarket` code. Stable `type` codes
 * with Vietnamese labels; optional documents carry `required: false`.
 *
 * (Requirements 12.1)
 */
export const DEFAULT_DOC_CATALOG: Readonly<Record<string, readonly DocTypeDef[]>> = Object.freeze({
  // Nhật Bản (TOKUTEI / TTS / Kỹ sư)
  JAPAN: Object.freeze([
    { type: 'PASSPORT', label: 'Hộ chiếu', required: true },
    { type: 'NATIONAL_ID', label: 'CCCD/CMND', required: true },
    { type: 'CV_RESUME', label: 'Sơ yếu lý lịch', required: true },
    { type: 'EDU_CERTIFICATE', label: 'Bằng tốt nghiệp', required: true },
    { type: 'HEALTH_CHECK', label: 'Giấy khám sức khỏe', required: true },
    { type: 'ID_PHOTO', label: 'Ảnh thẻ', required: true },
    { type: 'JP_LANGUAGE_CERT', label: 'Chứng chỉ tiếng Nhật/JFT', required: false },
    { type: 'CRIMINAL_RECORD', label: 'Lý lịch tư pháp', required: true },
  ] as const),

  // Hàn Quốc (EPS)
  KOREA: Object.freeze([
    { type: 'PASSPORT', label: 'Hộ chiếu', required: true },
    { type: 'NATIONAL_ID', label: 'CCCD/CMND', required: true },
    { type: 'EPS_TOPIK', label: 'Chứng chỉ EPS-TOPIK', required: true },
    { type: 'HEALTH_CHECK', label: 'Giấy khám sức khỏe', required: true },
    { type: 'CV_RESUME', label: 'Sơ yếu lý lịch', required: true },
    { type: 'ID_PHOTO', label: 'Ảnh thẻ', required: true },
    { type: 'CRIMINAL_RECORD', label: 'Lý lịch tư pháp', required: true },
  ] as const),

  // Đức
  GERMANY: Object.freeze([
    { type: 'PASSPORT', label: 'Hộ chiếu', required: true },
    { type: 'NATIONAL_ID', label: 'CCCD/CMND', required: true },
    { type: 'DE_LANGUAGE_CERT', label: 'Chứng chỉ tiếng Đức B1/B2', required: true },
    { type: 'VOCATIONAL_CERT', label: 'Bằng/Chứng chỉ nghề', required: true },
    { type: 'HEALTH_CHECK', label: 'Giấy khám sức khỏe', required: true },
    { type: 'CV_RESUME', label: 'Sơ yếu lý lịch (CV chuẩn EU)', required: true },
    { type: 'ID_PHOTO', label: 'Ảnh thẻ', required: true },
  ] as const),

  // Đài Loan
  TAIWAN: Object.freeze([
    { type: 'PASSPORT', label: 'Hộ chiếu', required: true },
    { type: 'NATIONAL_ID', label: 'CCCD/CMND', required: true },
    { type: 'HEALTH_CHECK', label: 'Giấy khám sức khỏe', required: true },
    { type: 'CV_RESUME', label: 'Sơ yếu lý lịch', required: true },
    { type: 'ID_PHOTO', label: 'Ảnh thẻ', required: true },
    { type: 'CRIMINAL_RECORD', label: 'Lý lịch tư pháp', required: true },
  ] as const),

  // Trong nước
  DOMESTIC: Object.freeze([
    { type: 'NATIONAL_ID', label: 'CCCD/CMND', required: true },
    { type: 'CV_RESUME', label: 'Sơ yếu lý lịch', required: true },
    { type: 'EDU_CERTIFICATE', label: 'Bằng cấp/chứng chỉ liên quan', required: false },
    { type: 'ID_PHOTO', label: 'Ảnh thẻ', required: true },
  ] as const),

  // Thị trường khác / mặc định
  OTHER: Object.freeze([
    { type: 'PASSPORT', label: 'Hộ chiếu', required: true },
    { type: 'NATIONAL_ID', label: 'CCCD/CMND', required: true },
    { type: 'CV_RESUME', label: 'Sơ yếu lý lịch', required: true },
    { type: 'HEALTH_CHECK', label: 'Giấy khám sức khỏe', required: true },
    { type: 'ID_PHOTO', label: 'Ảnh thẻ', required: true },
  ] as const),
});

/**
 * Resolve the default document set for a market code, returning fresh, mutable
 * copies of the `DocTypeDef`s so callers cannot mutate the frozen catalog.
 *
 * Falls back to the `OTHER` set when `market` is null, undefined, or not a
 * supported market code. (Requirements 12.1, 12.3)
 */
export function defaultDocsForMarket(market: string | null | undefined): DocTypeDef[] {
  const key = typeof market === 'string' ? market : '';
  // Use an own-property check so inherited Object.prototype members
  // (e.g. 'valueOf', 'constructor', 'toString') do NOT resolve to a function
  // via the prototype chain; unknown markets must fall back to OTHER.
  const set = Object.prototype.hasOwnProperty.call(DEFAULT_DOC_CATALOG, key)
    ? DEFAULT_DOC_CATALOG[key]
    : DEFAULT_DOC_CATALOG[FALLBACK_MARKET];
  return set.map((doc) => ({ ...doc }));
}
