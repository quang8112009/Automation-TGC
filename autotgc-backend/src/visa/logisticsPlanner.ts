/**
 * Logistics_Planner — pure suggestion engine for post-visa logistics
 * (vé máy bay, bảo hiểm, đưa đón sân bay, chỗ ở). Framework-free + deterministic
 * so it is property-testable; the service persists the chosen plan as a
 * LogisticsPlan row and can override any suggested field.
 *
 * Suggestions are grounded, country-aware DEFAULTS (e.g. OSHC for Australia,
 * IHS-backed NHS for the UK) plus a checklist of what the candidate must
 * prepare. It invents no prices or provider names it cannot justify.
 */
import { normalizeCountry } from './visaCatalog';

export type InsuranceType = 'OSHC' | 'IHS' | 'TRAVEL' | 'PRIVATE_HEALTH' | 'NONE';
export type HousingType = 'HOMESTAY' | 'DORMITORY' | 'RENTAL' | 'NONE';

export interface LogisticsSuggestion {
  /** Recommended insurance kind for the destination. */
  insuranceType: InsuranceType;
  /** Recommended initial housing kind. */
  housingType: HousingType;
  /** Whether arranging an airport pickup is recommended by default. */
  recommendPickup: boolean;
  /** Vietnamese preparation checklist lines for the candidate. */
  checklist: string[];
  /** Short rationale notes (Vietnamese). */
  notes: string[];
}

/** Country -> recommended insurance kind. */
const INSURANCE_BY_COUNTRY: Readonly<Record<string, InsuranceType>> = {
  AUSTRALIA: 'OSHC',
  UK: 'IHS',
  USA: 'PRIVATE_HEALTH',
  CANADA: 'PRIVATE_HEALTH',
  JAPAN: 'TRAVEL',
  KOREA: 'TRAVEL',
  GERMANY: 'PRIVATE_HEALTH',
  TAIWAN: 'TRAVEL',
};

/**
 * Produce a default logistics suggestion for a destination country. Unknown
 * countries get a safe TRAVEL-insurance + homestay default with a generic
 * checklist (never throws).
 */
export function suggestLogistics(country: string | null | undefined): LogisticsSuggestion {
  const key = normalizeCountry(country);
  const insuranceType = INSURANCE_BY_COUNTRY[key] ?? 'TRAVEL';
  const housingType: HousingType = 'HOMESTAY';

  const checklist: string[] = [
    'Đặt vé máy bay (ưu tiên vé khứ hồi/linh hoạt nếu chưa chắc lịch).',
    'Chuẩn bị bảo hiểm y tế phù hợp với quốc gia đến.',
    'Sắp xếp chỗ ở cho thời gian đầu (homestay hoặc ký túc xá của trường).',
    'Đăng ký dịch vụ đưa đón sân bay để thuận tiện ngày đầu nhập cảnh.',
    'Photo + scan toàn bộ giấy tờ quan trọng, lưu bản mềm dự phòng.',
  ];

  const notes: string[] = [];
  switch (insuranceType) {
    case 'OSHC':
      notes.push('Úc yêu cầu bảo hiểm OSHC cho toàn bộ thời gian học (điều kiện cấp visa).');
      break;
    case 'IHS':
      notes.push('Anh yêu cầu đóng phí IHS để dùng dịch vụ y tế NHS trong thời gian lưu trú.');
      break;
    case 'PRIVATE_HEALTH':
      notes.push('Nên mua bảo hiểm y tế tư nhân đủ hạn mức theo yêu cầu của trường/chương trình.');
      break;
    case 'TRAVEL':
      notes.push('Khuyến nghị bảo hiểm du lịch/y tế cho giai đoạn đầu khi chưa có bảo hiểm địa phương.');
      break;
    default:
      break;
  }
  notes.push('Liên hệ đối tác dịch vụ đưa đón/nhà ở đã hợp tác để được hỗ trợ tốt nhất.');

  return {
    insuranceType,
    housingType,
    recommendPickup: true,
    checklist,
    notes,
  };
}
