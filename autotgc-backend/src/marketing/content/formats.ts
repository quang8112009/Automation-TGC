/**
 * Multi-format content taxonomy for the AI marketing autopilot (Thanh Giang —
 * Vietnamese labor-export / XKLĐ).
 *
 * Pure module: NO Prisma / Fastify / I/O. It is the single source of truth for
 * the `format` String stored on ContentDraft (the Prisma schema keeps `format`
 * as a String defaulting to 'GENERIC'). The route + generator layers narrow
 * untrusted input through `isContentFormat` and read presentation/contract facts
 * from `FORMAT_META`.
 */

/** Canonical content-format codes (mirror the ContentDraft.format String values). */
export const CONTENT_FORMATS = [
  'GENERIC',
  'SEO_ARTICLE',
  'FANPAGE_CAPTION',
  'VIDEO_SCRIPT',
  'EMAIL',
  'CARE_MESSAGE',
  'CHATBOT_FAQ',
] as const;

export type ContentFormat = (typeof CONTENT_FORMATS)[number];

const FORMAT_SET: ReadonlySet<string> = new Set<string>(CONTENT_FORMATS);

/** Pure type guard: true iff `v` is one of the canonical content-format codes. */
export function isContentFormat(v: unknown): v is ContentFormat {
  return typeof v === 'string' && FORMAT_SET.has(v);
}

/** Per-format presentation + contract metadata. */
export interface FormatMeta {
  /** Vietnamese, human-facing label. */
  label: string;
  /** Whether the model MUST return at least one CTA (else one is synthesized). */
  ctasRequired: boolean;
  /** Vietnamese length / shape hint surfaced to the UI and embedded in prompts. */
  lengthHint: string;
}

/**
 * Vietnamese labels + contract flags for each format. `ctasRequired` is false for
 * CARE_MESSAGE / CHATBOT_FAQ (a sensible default CTA is synthesized when the model
 * returns none, so the DraftCta ≥1 UX invariant still holds).
 */
export const FORMAT_META: Record<ContentFormat, FormatMeta> = {
  GENERIC: {
    label: 'Nội dung tổng quát',
    ctasRequired: true,
    lengthHint: 'Độ dài linh hoạt theo mục tiêu',
  },
  SEO_ARTICLE: {
    label: 'Bài viết chuẩn SEO',
    ctasRequired: true,
    lengthHint: '800–1500 từ, có thẻ H2/H3 và meta description',
  },
  FANPAGE_CAPTION: {
    label: 'Caption Fanpage',
    ctasRequired: true,
    lengthHint: 'Tối đa 600 ký tự, kèm hashtag',
  },
  VIDEO_SCRIPT: {
    label: 'Kịch bản video ngắn',
    ctasRequired: true,
    lengthHint: '30–60 giây: hook + cảnh quay + voiceover + chữ trên màn hình',
  },
  EMAIL: {
    label: 'Email chăm sóc',
    ctasRequired: true,
    lengthHint: 'Tiêu đề (subject) + thân email ngắn gọn',
  },
  CARE_MESSAGE: {
    label: 'Tin nhắn chăm sóc',
    ctasRequired: false,
    lengthHint: 'Ngắn gọn, giọng Zalo/SMS',
  },
  CHATBOT_FAQ: {
    label: 'Kịch bản chatbot FAQ',
    ctasRequired: false,
    lengthHint: 'Các cặp Hỏi–Đáp ngắn gọn',
  },
};
