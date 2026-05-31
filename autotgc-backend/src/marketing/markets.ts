/**
 * Canonical MARKET list + metadata for Thanh Giang (Vietnamese labor-export / XKLĐ).
 *
 * Pure module: no Prisma/Fastify. The market codes mirror the free-form `market`
 * string stored on TrendSignal / ContentPlan / ContentPlanItem (the Prisma schema
 * keeps `market` as a String, so this module is the single source of truth for the
 * allowed set used by the research + planning services and the route layer).
 */

/** Canonical market codes used across trend research + content planning. */
export const MARKETS = [
  'JAPAN',
  'KOREA',
  'GERMANY',
  'TAIWAN',
  'AUSTRALIA',
  'LITHUANIA',
  'EUROPE',
  'DOMESTIC',
  'OTHER',
] as const;

export type Market = (typeof MARKETS)[number];

const MARKET_SET: ReadonlySet<string> = new Set<string>(MARKETS);

/** Pure type guard: true iff `v` is one of the canonical market codes. */
export function isMarket(v: unknown): v is Market {
  return typeof v === 'string' && MARKET_SET.has(v);
}

/** Vietnamese display labels for each market (UI / human-facing). */
export const MARKET_LABELS: Readonly<Record<Market, string>> = {
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

/** Resolve a Vietnamese label for any value, falling back to OTHER's label. */
export function marketLabel(v: unknown): string {
  return isMarket(v) ? MARKET_LABELS[v] : MARKET_LABELS.OTHER;
}
