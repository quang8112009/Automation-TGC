/**
 * Intake flow definitions — the custom dossier questions the chatbot asks.
 *
 * Pure data + a small registry. The default XKLĐ flow collects exactly the
 * fields the recruitment dossier + destination-matching agent need (name,
 * contact, age, gender, market, industry, language level, budget). Field keys
 * map onto Lead / CandidateProfile columns via `mapsTo` so a completed
 * conversation can be promoted into the central system without guesswork.
 */
import type { IntakeFlow } from './intakeFlow';

/** Default labor-export (XKLĐ) intake flow, in Vietnamese. */
export const XKLD_DEFAULT_FLOW: IntakeFlow = {
  key: 'xkld_default',
  greeting:
    'Xin chào! Cảm ơn bạn đã quan tâm tới chương trình của Thanh Giang. Mình xin phép hỏi ' +
    'một vài thông tin để tư vấn chính xác nhất cho bạn nhé.',
  completion:
    'Cảm ơn bạn! Mình đã ghi nhận đầy đủ thông tin. Chuyên viên tư vấn sẽ liên hệ với bạn ' +
    'trong thời gian sớm nhất để hỗ trợ chi tiết.',
  fields: [
    {
      key: 'fullName',
      prompt: 'Bạn cho mình xin họ và tên đầy đủ nhé?',
      type: 'text',
      required: true,
      mapsTo: 'fullName',
    },
    {
      key: 'phone',
      prompt: 'Số điện thoại để chuyên viên liên hệ với bạn là gì ạ?',
      type: 'phone',
      required: true,
      mapsTo: 'phone',
    },
    {
      key: 'age',
      prompt: 'Bạn năm nay bao nhiêu tuổi?',
      type: 'number',
      required: true,
    },
    {
      key: 'gender',
      prompt: 'Giới tính của bạn là gì? (Nam/Nữ)',
      type: 'choice',
      required: true,
      choices: ['Nam', 'Nữ'],
      mapsTo: 'gender',
    },
    {
      key: 'desiredMarket',
      prompt:
        'Bạn muốn đi thị trường nào? (Nhật Bản, Hàn Quốc, Đức, Đài Loan, Úc, hoặc thị trường khác)',
      type: 'choice',
      required: true,
      choices: ['Nhật Bản', 'Hàn Quốc', 'Đức', 'Đài Loan', 'Úc', 'Khác'],
      mapsTo: 'desiredMarket',
    },
    {
      key: 'desiredIndustry',
      prompt: 'Bạn quan tâm tới ngành nghề nào? (VD: Xây dựng, Cơ khí, Điều dưỡng, Nông nghiệp...)',
      type: 'text',
      required: true,
      mapsTo: 'desiredIndustry',
    },
    {
      key: 'languageLevel',
      prompt:
        'Trình độ ngoại ngữ hiện tại của bạn? (VD: Tiếng Nhật N4, IELTS 5.5, hoặc Chưa có)',
      type: 'text',
      required: false,
    },
    {
      key: 'education',
      prompt: 'Trình độ học vấn cao nhất của bạn là gì? (VD: THPT, Trung cấp, Cao đẳng, Đại học)',
      type: 'text',
      required: false,
      mapsTo: 'education',
    },
    {
      key: 'budgetVndM',
      prompt: 'Ngân sách dự kiến của bạn cho chương trình là bao nhiêu (triệu VND)?',
      type: 'number',
      required: false,
    },
    {
      key: 'email',
      prompt: 'Cuối cùng, bạn cho mình xin email (nếu có) để gửi tài liệu nhé?',
      type: 'email',
      required: false,
      mapsTo: 'email',
    },
  ],
};

/** Registry of available flows by key. */
const FLOWS: Readonly<Record<string, IntakeFlow>> = {
  [XKLD_DEFAULT_FLOW.key]: XKLD_DEFAULT_FLOW,
};

/** Resolve a flow by key, falling back to the default XKLĐ flow. */
export function getFlow(key?: string | null): IntakeFlow {
  if (key && FLOWS[key]) return FLOWS[key];
  return XKLD_DEFAULT_FLOW;
}

/** All registered flow keys (for listing / admin). */
export function flowKeys(): string[] {
  return Object.keys(FLOWS);
}
