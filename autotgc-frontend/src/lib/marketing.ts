/**
 * AI Marketing Autopilot constants + Vietnamese labels (customer: Thanh Giang,
 * XKLĐ). Enum values mirror the backend (src/marketing/*); labels are the
 * product language (Vietnamese). Pure module — no I/O.
 */
import type {
  AssetKind,
  ContentFormatCode,
  MarketingChannel,
  MarketingMarket,
  MarketingObjective,
  PlanItemStatus,
  PlanStatus,
  TemplateKind,
  TrendStatus,
} from './types';

// ---- Markets ---------------------------------------------------------------

export const MARKETING_MARKETS: MarketingMarket[] = [
  'JAPAN',
  'KOREA',
  'GERMANY',
  'TAIWAN',
  'AUSTRALIA',
  'LITHUANIA',
  'EUROPE',
  'DOMESTIC',
  'OTHER',
];

export const MARKETING_MARKET_LABELS: Record<MarketingMarket, string> = {
  JAPAN: 'Nhật Bản',
  KOREA: 'Hàn Quốc',
  GERMANY: 'Đức',
  TAIWAN: 'Đài Loan',
  AUSTRALIA: 'Úc',
  LITHUANIA: 'Litva',
  EUROPE: 'Châu Âu',
  DOMESTIC: 'Trong nước',
  OTHER: 'Thị trường khác',
};

export function marketingMarketLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return MARKETING_MARKET_LABELS[value as MarketingMarket] ?? value;
}

// ---- Content formats -------------------------------------------------------

export const CONTENT_FORMAT_CODES: ContentFormatCode[] = [
  'GENERIC',
  'SEO_ARTICLE',
  'FANPAGE_CAPTION',
  'VIDEO_SCRIPT',
  'EMAIL',
  'CARE_MESSAGE',
  'CHATBOT_FAQ',
];

export const CONTENT_FORMAT_LABELS: Record<ContentFormatCode, string> = {
  GENERIC: 'Nội dung tổng quát',
  SEO_ARTICLE: 'Bài viết chuẩn SEO',
  FANPAGE_CAPTION: 'Caption Fanpage',
  VIDEO_SCRIPT: 'Kịch bản video ngắn',
  EMAIL: 'Email chăm sóc',
  CARE_MESSAGE: 'Tin nhắn chăm sóc',
  CHATBOT_FAQ: 'Kịch bản chatbot FAQ',
};

export function contentFormatLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return CONTENT_FORMAT_LABELS[value as ContentFormatCode] ?? value;
}

// ---- Channels --------------------------------------------------------------

export const MARKETING_CHANNELS: MarketingChannel[] = [
  'facebook',
  'tiktok',
  'youtube',
  'website',
  'zalo',
  'email',
];

export const MARKETING_CHANNEL_LABELS: Record<MarketingChannel, string> = {
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  website: 'Website',
  zalo: 'Zalo',
  email: 'Email',
};

export function channelLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return MARKETING_CHANNEL_LABELS[value as MarketingChannel] ?? value;
}

/** Channels the scheduler accepts in Phase 1 (others are generated, not scheduled). */
export const SCHEDULABLE_CHANNELS: ReadonlySet<string> = new Set<string>([
  'facebook',
  'tiktok',
  'website',
]);

// ---- Objectives ------------------------------------------------------------

export const MARKETING_OBJECTIVES: MarketingObjective[] = ['Lead', 'View', 'Follow'];

export const MARKETING_OBJECTIVE_LABELS: Record<MarketingObjective, string> = {
  Lead: 'Thu lead (khách hàng tiềm năng)',
  View: 'Tăng lượt xem',
  Follow: 'Tăng người theo dõi',
};

export function objectiveLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return MARKETING_OBJECTIVE_LABELS[value as MarketingObjective] ?? value;
}

// ---- Trend status ----------------------------------------------------------

export const TREND_STATUS_LABELS: Record<TrendStatus, string> = {
  DISCOVERED: 'Mới phát hiện',
  REVIEWED: 'Đã xem xét',
  ADOPTED: 'Đã chọn dùng',
  DISMISSED: 'Đã bỏ qua',
};

export const TREND_STATUS_BADGE: Record<TrendStatus, string> = {
  DISCOVERED: 'badge-blue',
  REVIEWED: 'badge-yellow',
  ADOPTED: 'badge-green',
  DISMISSED: 'badge-gray',
};

export function trendStatusLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return TREND_STATUS_LABELS[value as TrendStatus] ?? value;
}

export const TREND_INTENT_LABELS: Record<string, string> = {
  salary: 'Lương',
  visa: 'Visa',
  eligibility: 'Điều kiện',
  cost: 'Chi phí',
  industries: 'Ngành nghề',
};

export function trendIntentLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return TREND_INTENT_LABELS[value] ?? value;
}

// ---- Plan status -----------------------------------------------------------

export const PLAN_STATUSES: PlanStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  DRAFT: 'Nháp',
  ACTIVE: 'Đang chạy',
  ARCHIVED: 'Đã lưu trữ',
};

export const PLAN_STATUS_BADGE: Record<PlanStatus, string> = {
  DRAFT: 'badge-gray',
  ACTIVE: 'badge-green',
  ARCHIVED: 'badge-yellow',
};

export function planStatusLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return PLAN_STATUS_LABELS[value as PlanStatus] ?? value;
}

// ---- Plan item status ------------------------------------------------------

export const PLAN_ITEM_STATUS_LABELS: Record<PlanItemStatus, string> = {
  PLANNED: 'Đã lên kế hoạch',
  GENERATED: 'Đã tạo nội dung',
  SCHEDULED: 'Đã lên lịch',
  PUBLISHED: 'Đã đăng',
  SKIPPED: 'Bỏ qua',
};

export const PLAN_ITEM_STATUS_BADGE: Record<PlanItemStatus, string> = {
  PLANNED: 'badge-gray',
  GENERATED: 'badge-blue',
  SCHEDULED: 'badge-yellow',
  PUBLISHED: 'badge-green',
  SKIPPED: 'badge-gray',
};

export function planItemStatusLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return PLAN_ITEM_STATUS_LABELS[value as PlanItemStatus] ?? value;
}

// ---- Asset kinds -----------------------------------------------------------

export const ASSET_KINDS: AssetKind[] = ['thumbnail', 'infographic', 'poster', 'short_video', 'image'];

export const TEMPLATE_KINDS: TemplateKind[] = ['thumbnail', 'infographic', 'poster', 'short_video'];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  thumbnail: 'Thumbnail (ảnh bìa)',
  infographic: 'Infographic',
  poster: 'Poster',
  short_video: 'Video ngắn',
  image: 'Ảnh',
};

export function assetKindLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return ASSET_KIND_LABELS[value as AssetKind] ?? value;
}

// ---- Autopilot step labels -------------------------------------------------

/** Canonical autopilot step order + Vietnamese labels for the progress timeline. */
export const AUTOPILOT_STEP_ORDER: string[] = [
  'research',
  'plan',
  'generate',
  'review_gate',
  'schedule',
  'summary',
];

export const AUTOPILOT_STEP_LABELS: Record<string, string> = {
  research: 'Nghiên cứu xu hướng',
  plan: 'Lập kế hoạch nội dung',
  generate: 'Tạo nội dung & tài sản',
  review_gate: 'Cổng phê duyệt (con người)',
  schedule: 'Lên lịch đăng',
  summary: 'Tổng kết',
};

export function autopilotStepLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return AUTOPILOT_STEP_LABELS[value] ?? value;
}

/** Workflow run statuses that are terminal (stop polling). */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set<string>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
