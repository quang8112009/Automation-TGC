/**
 * Interview_Question_Bank — pure, deterministic visa-interview question sets
 * grounded in the country knowledge of `visaCatalog`.
 *
 * Framework-free: the only dependency is `visaCatalog` (for `normalizeCountry`
 * and `hasCountryTemplate`), so the bank is deterministic and property-testable.
 * Question prompts are in Vietnamese (the product language) with English visa
 * terms preserved where natural (e.g. I-20, SEVIS, CAS, GTE, OSHC).
 *
 * Grounding strategy: each country with a `visaCatalog` template (USA, UK,
 * CANADA, AUSTRALIA, JAPAN) gets a hand-curated set anchored on that country's
 * documents/checklist (e.g. USA F-1 → I-20/SEVIS/DS-160). Countries WITHOUT a
 * specific template fall back to a safe GENERIC set (study plan, financial
 * proof, intent, accommodation) — never inventing country-specific policy.
 */

import { normalizeCountry, hasCountryTemplate } from '../visa/visaCatalog';
import type { InterviewQuestion } from './types';

/**
 * Safe generic question set for countries without a specific `visaCatalog`
 * template. Covers study plan, financial proof, intent, and accommodation —
 * topics common to virtually every study-abroad interview. (Req 10.4)
 */
const GENERIC_QUESTIONS: readonly InterviewQuestion[] = [
  {
    code: 'GEN_STUDY_PLAN',
    prompt: 'Vì sao bạn chọn chương trình học và ngành này? Kế hoạch học tập (study plan) của bạn là gì?',
    category: 'STUDY_PLAN',
  },
  {
    code: 'GEN_FINANCE',
    prompt: 'Ai là người tài trợ cho việc học của bạn và bạn chứng minh tài chính (financial proof) như thế nào?',
    category: 'FINANCE',
  },
  {
    code: 'GEN_INTENT',
    prompt: 'Sau khi hoàn thành khóa học bạn dự định làm gì? Điều gì ràng buộc bạn quay về nước (intent to return)?',
    category: 'INTENT',
  },
  {
    code: 'GEN_ACCOMMODATION',
    prompt: 'Bạn đã chuẩn bị chỗ ở (accommodation) tại nước sở tại như thế nào?',
    category: 'ACCOMMODATION',
  },
];

/** USA F-1 student set — anchored on I-20 / SEVIS / DS-160. (Req 10.1) */
const USA_QUESTIONS: readonly InterviewQuestion[] = [
  {
    code: 'USA_I20',
    prompt: 'Bạn nhận Form I-20 từ trường nào và trường đó nằm ở bang nào?',
    category: 'DOCUMENTS',
  },
  {
    code: 'USA_SEVIS',
    prompt: 'Bạn đã đóng phí SEVIS (I-901) chưa và bạn hiểu hệ thống SEVIS dùng để làm gì?',
    category: 'DOCUMENTS',
  },
  {
    code: 'USA_DS160',
    prompt: 'Thông tin bạn khai trong đơn DS-160 có khớp với hồ sơ hiện tại của bạn không?',
    category: 'DOCUMENTS',
  },
  {
    code: 'USA_FUNDING',
    prompt: 'Ai chi trả học phí và sinh hoạt phí của bạn? Bạn chứng minh tài chính (financial proof) đủ cho năm học đầu tiên như thế nào?',
    category: 'FINANCE',
  },
  {
    code: 'USA_STUDY_PLAN',
    prompt: 'Vì sao bạn chọn trường và ngành học này tại Hoa Kỳ thay vì học trong nước?',
    category: 'STUDY_PLAN',
  },
  {
    code: 'USA_INTENT',
    prompt: 'Sau khi tốt nghiệp bạn dự định làm gì? Điều gì ràng buộc bạn quay về Việt Nam (intent to return)?',
    category: 'INTENT',
  },
];

/** UK student set — anchored on CAS / IHS + course choice + finances. (Req 10.1) */
const UK_QUESTIONS: readonly InterviewQuestion[] = [
  {
    code: 'UK_CAS',
    prompt: 'Bạn đã nhận CAS (Confirmation of Acceptance for Studies) từ trường chưa?',
    category: 'DOCUMENTS',
  },
  {
    code: 'UK_IHS',
    prompt: 'Bạn đã đóng phí IHS (Immigration Health Surcharge) cho thời gian học chưa?',
    category: 'DOCUMENTS',
  },
  {
    code: 'UK_COURSE',
    prompt: 'Vì sao bạn chọn khóa học và trường đại học này tại Vương quốc Anh?',
    category: 'STUDY_PLAN',
  },
  {
    code: 'UK_FINANCE',
    prompt: 'Bạn chứng minh tài chính (đủ học phí và sinh hoạt phí, sao kê đủ 28 ngày) như thế nào?',
    category: 'FINANCE',
  },
  {
    code: 'UK_INTENT',
    prompt: 'Kế hoạch của bạn sau khi hoàn thành khóa học tại Anh là gì?',
    category: 'INTENT',
  },
];

/** Australia student set — anchored on GTE / OSHC / CoE (genuine student). (Req 10.1) */
const AUSTRALIA_QUESTIONS: readonly InterviewQuestion[] = [
  {
    code: 'AUS_GTE',
    prompt: 'Hãy trình bày Genuine Temporary Entrant (GTE): vì sao bạn là sinh viên thực sự và dự định quay về sau khi học xong?',
    category: 'INTENT',
  },
  {
    code: 'AUS_COE',
    prompt: 'Bạn đã nhận Confirmation of Enrolment (CoE) từ trường chưa?',
    category: 'DOCUMENTS',
  },
  {
    code: 'AUS_OSHC',
    prompt: 'Bạn đã mua bảo hiểm y tế sinh viên OSHC (Overseas Student Health Cover) chưa?',
    category: 'DOCUMENTS',
  },
  {
    code: 'AUS_STUDY_PLAN',
    prompt: 'Vì sao bạn chọn khóa học này tại Úc và nó phù hợp với định hướng nghề nghiệp của bạn ra sao?',
    category: 'STUDY_PLAN',
  },
  {
    code: 'AUS_FINANCE',
    prompt: 'Bạn chứng minh khả năng tài chính cho học phí và sinh hoạt phí tại Úc như thế nào?',
    category: 'FINANCE',
  },
];

/** Canada student set — anchored on LOA / GIC + ties to home. (Req 10.1) */
const CANADA_QUESTIONS: readonly InterviewQuestion[] = [
  {
    code: 'CAN_LOA',
    prompt: 'Bạn đã nhận Letter of Acceptance (LOA) từ trường DLI nào?',
    category: 'DOCUMENTS',
  },
  {
    code: 'CAN_GIC',
    prompt: 'Bạn đã mở Guaranteed Investment Certificate (GIC) chưa và số tiền là bao nhiêu?',
    category: 'FINANCE',
  },
  {
    code: 'CAN_STUDY_PLAN',
    prompt: 'Vì sao bạn chọn chương trình học này tại Canada?',
    category: 'STUDY_PLAN',
  },
  {
    code: 'CAN_FINANCE',
    prompt: 'Ngoài GIC, bạn chứng minh tài chính cho học phí và sinh hoạt phí như thế nào?',
    category: 'FINANCE',
  },
  {
    code: 'CAN_INTENT',
    prompt: 'Mối ràng buộc nào khiến bạn quay về Việt Nam sau khi học xong (ties to home)?',
    category: 'INTENT',
  },
];

/** Japan student set — anchored on COE / JLPT. (Req 10.1) */
const JAPAN_QUESTIONS: readonly InterviewQuestion[] = [
  {
    code: 'JP_COE',
    prompt: 'Bạn đã nhận Giấy chứng nhận tư cách lưu trú (COE) chưa?',
    category: 'DOCUMENTS',
  },
  {
    code: 'JP_JLPT',
    prompt: 'Trình độ tiếng Nhật (JLPT/NAT) của bạn ở mức nào và bạn đã học tiếng Nhật bao lâu?',
    category: 'LANGUAGE',
  },
  {
    code: 'JP_STUDY_PLAN',
    prompt: 'Vì sao bạn chọn trường này tại Nhật Bản và kế hoạch học tập của bạn là gì?',
    category: 'STUDY_PLAN',
  },
  {
    code: 'JP_FINANCE',
    prompt: 'Ai là người bảo lãnh tài chính của bạn và bạn chứng minh tài chính như thế nào?',
    category: 'FINANCE',
  },
  {
    code: 'JP_INTENT',
    prompt: 'Sau khi học xong tại Nhật Bản bạn dự định làm gì?',
    category: 'INTENT',
  },
];

/**
 * Country-specific banks keyed by the `visaCatalog` normalized country code.
 * Keys MUST stay aligned with the countries that have a `visaCatalog` template
 * (see `hasCountryTemplate`); a missing key safely degrades to the generic set.
 */
const COUNTRY_QUESTIONS: Readonly<Record<string, readonly InterviewQuestion[]>> = {
  USA: USA_QUESTIONS,
  UK: UK_QUESTIONS,
  AUSTRALIA: AUSTRALIA_QUESTIONS,
  CANADA: CANADA_QUESTIONS,
  JAPAN: JAPAN_QUESTIONS,
};

/**
 * Optional visa-type refinements layered on top of a country's base set. Keyed
 * by `country -> visaTypeToken -> extra questions`, where `visaTypeToken` is a
 * substring matched against the normalized (trimmed, uppercased) visa type.
 * Deterministic: the same `(country, visaType)` always yields the same extras
 * appended in declaration order.
 */
const VISA_TYPE_REFINEMENTS: Readonly<
  Record<string, ReadonlyArray<{ readonly token: string; readonly questions: readonly InterviewQuestion[] }>>
> = {
  USA: [
    {
      token: 'J-1',
      questions: [
        {
          code: 'USA_J1_HOME_RESIDENCY',
          prompt: 'Đây là visa trao đổi (J-1): bạn có hiểu yêu cầu cư trú tại nước nhà 2 năm (two-year home-residency) sau chương trình không?',
          category: 'INTENT',
        },
      ],
    },
    {
      token: 'J1',
      questions: [
        {
          code: 'USA_J1_HOME_RESIDENCY',
          prompt: 'Đây là visa trao đổi (J-1): bạn có hiểu yêu cầu cư trú tại nước nhà 2 năm (two-year home-residency) sau chương trình không?',
          category: 'INTENT',
        },
      ],
    },
    {
      token: 'M-1',
      questions: [
        {
          code: 'USA_M1_VOCATIONAL',
          prompt: 'Đây là visa đào tạo nghề (M-1): chương trình đào tạo nghề bạn theo học là gì và vì sao bạn chọn nó?',
          category: 'STUDY_PLAN',
        },
      ],
    },
    {
      token: 'M1',
      questions: [
        {
          code: 'USA_M1_VOCATIONAL',
          prompt: 'Đây là visa đào tạo nghề (M-1): chương trình đào tạo nghề bạn theo học là gì và vì sao bạn chọn nó?',
          category: 'STUDY_PLAN',
        },
      ],
    },
  ],
};

/** Normalize a visa type to a comparison token (trimmed + uppercased). */
function normalizeVisaType(visaType: string | null | undefined): string {
  return (visaType ?? '').trim().toUpperCase();
}

/**
 * Build the deterministic visa-interview question set for a country/visa type,
 * grounded in the country knowledge of `visaCatalog`.
 *
 * - Countries WITH a `visaCatalog` template (USA, UK, CANADA, AUSTRALIA, JAPAN)
 *   return a curated set anchored on that country's documents (e.g. USA F-1 →
 *   I-20/SEVIS/DS-160; UK → CAS/IHS; AUSTRALIA → GTE/OSHC). (Req 10.1)
 * - Countries WITHOUT a specific template return the safe GENERIC set (study
 *   plan, financial proof, intent, accommodation) — no AI, no invented policy.
 *   (Req 10.4)
 * - `visaType`, when provided, may append deterministic visa-type-specific
 *   questions (e.g. USA J-1 home-residency, M-1 vocational) without removing
 *   any base question. (Req 10.1)
 * - Pure + deterministic: the same `(country, visaType)` always yields the same
 *   questions in the same order; the returned array is a fresh copy so callers
 *   cannot mutate the internal banks. (Req 10.3)
 */
export function questionBankFor(
  country: string | null | undefined,
  visaType?: string | null,
): InterviewQuestion[] {
  // No specific country template → safe generic fallback set. (Req 10.4)
  if (!hasCountryTemplate(country)) {
    return [...GENERIC_QUESTIONS];
  }

  const key = normalizeCountry(country);
  const base = COUNTRY_QUESTIONS[key];
  // Defensive: a templated country we have not curated yet degrades to generic.
  if (base === undefined) {
    return [...GENERIC_QUESTIONS];
  }

  const questions: InterviewQuestion[] = [...base];

  // Append deterministic visa-type refinements (de-duplicated by code).
  const token = normalizeVisaType(visaType);
  if (token.length > 0) {
    const refinements = VISA_TYPE_REFINEMENTS[key];
    if (refinements !== undefined) {
      const seen = new Set(questions.map((q) => q.code));
      for (const refinement of refinements) {
        if (token.includes(refinement.token)) {
          for (const q of refinement.questions) {
            if (!seen.has(q.code)) {
              questions.push(q);
              seen.add(q.code);
            }
          }
        }
      }
    }
  }

  return questions;
}
