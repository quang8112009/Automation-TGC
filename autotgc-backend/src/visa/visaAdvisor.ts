/**
 * VisaAdvisor — AI-grounded advice layer over the pure visa catalog + logistics
 * planner (the "custom lại AI" piece). It produces a concise Vietnamese advisory
 * for a candidate's visa case: which documents/deadlines matter most next, plus
 * the recommended insurance/housing/pickup — grounded in the deterministic
 * catalog/planner output and (optionally) phrased by Gemini.
 *
 * Gemini-optional, mirroring RecruitmentConsultantAgent / PersonaService: with
 * no key (or on any failure) it returns a deterministic grounded advisory
 * (aiGenerated:false) and never throws. Pure prompt builders are exported for
 * testing; only `advise` touches the injected Gemini seam.
 */
import type { ContentGenerator } from '../strategy/personaService';
import { checklistFor, withDeadlines, normalizeCountry } from './visaCatalog';
import { suggestLogistics } from './logisticsPlanner';

export interface VisaAdviceInput {
  country: string;
  targetIntakeDate?: Date | null;
  candidateName?: string;
}

export interface VisaAdvice {
  advisory: string;
  /** The next few most-urgent tasks (earliest deadline first), as labels. */
  nextTasks: string[];
  insuranceType: string;
  housingType: string;
  aiGenerated: boolean;
}

/**
 * Pure: build the deterministic advisory text from the catalog + planner. Lists
 * the soonest required tasks with their deadlines (when an intake date is set)
 * and the recommended logistics. Never invents facts.
 */
export function buildDeterministicAdvice(input: VisaAdviceInput): Omit<VisaAdvice, 'aiGenerated'> {
  const country = normalizeCountry(input.country);
  const dated = withDeadlines(checklistFor(country), input.targetIntakeDate ?? null);
  const logistics = suggestLogistics(country);

  // Earliest-deadline required tasks first (dated list is already lead-sorted).
  const required = dated.filter((t) => t.required).slice(0, 5);
  const nextTasks = required.map((t) => {
    if (t.dueAt) {
      const d = t.dueAt.toISOString().slice(0, 10);
      return `${t.label} (hạn ~ ${d})`;
    }
    return t.label;
  });

  const lines: string[] = [];
  const who = input.candidateName ? `cho ${input.candidateName}` : 'cho ứng viên';
  lines.push(`Lộ trình hồ sơ visa ${country} ${who}:`);
  for (const t of nextTasks) lines.push(`• ${t}`);
  lines.push('');
  lines.push(`Bảo hiểm khuyến nghị: ${logistics.insuranceType}. Chỗ ở ban đầu: ${logistics.housingType}.`);
  if (logistics.recommendPickup) lines.push('Nên sắp xếp dịch vụ đưa đón sân bay cho ngày nhập cảnh.');
  for (const n of logistics.notes) lines.push(`- ${n}`);

  return {
    advisory: lines.join('\n'),
    nextTasks,
    insuranceType: logistics.insuranceType,
    housingType: logistics.housingType,
  };
}

/** Pure grounding prompt for Gemini phrasing (no secrets, fully grounded). */
export function buildAdvicePrompt(base: Omit<VisaAdvice, 'aiGenerated'>, country: string): string {
  return [
    'Bạn là chuyên viên tư vấn du học / xuất khẩu lao động.',
    `Hãy viết lại phần tư vấn visa & hậu cần cho ${country} bằng tiếng Việt, ngắn gọn, ` +
      'rõ ràng, động viên ứng viên. CHỈ dựa trên thông tin dưới đây, KHÔNG bịa thêm số liệu/chi phí.',
    '',
    'Dữ liệu nền:',
    base.advisory,
  ].join('\n');
}

export class VisaAdvisor {
  constructor(private readonly gemini?: ContentGenerator) {}

  /**
   * Produce an advisory. With Gemini configured, the deterministic advisory is
   * re-phrased (aiGenerated:true); on any failure or absence it returns the
   * deterministic text (aiGenerated:false). Never throws for missing AI.
   */
  async advise(input: VisaAdviceInput): Promise<VisaAdvice> {
    const base = buildDeterministicAdvice(input);
    if (this.gemini) {
      try {
        const text = await this.gemini.generateContent(
          buildAdvicePrompt(base, normalizeCountry(input.country)),
        );
        if (text && text.trim().length > 0) {
          return { ...base, advisory: text.trim(), aiGenerated: true };
        }
      } catch {
        // fall through to deterministic
      }
    }
    return { ...base, aiGenerated: false };
  }
}
