/**
 * Scoring_Engine pure logic (Analytics Req 6, 7, 8).
 * Derived rates with divide-by-zero safety, INSUFFICIENT_DATA, platform metric availability.
 */
export type Platform = 'facebook' | 'tiktok' | 'website';
export type PerformanceLabel =
  | 'HIGH_PERFORMER' | 'AVERAGE_PERFORMER' | 'LOW_PERFORMER' | 'INSUFFICIENT_DATA';

export interface RawMetrics {
  views?: number | null;
  likes?: number | null;
  shares?: number | null;
  comments?: number | null;
  follows?: number | null;
  leads?: number | null;
  clickThrough?: number | null;
  reach?: number | null;
}

export interface DerivedRates {
  conversionRate: number;
  engagementRate: number;
  ctaClickRate: number;
  followRate: number | null;
}

export interface ScoringConfig {
  highThreshold: number; // default 5
  midThreshold: number; // default 2
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = { highThreshold: 5, midThreshold: 2 };

const n = (v: number | null | undefined): number => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);

/**
 * Compute derived rates. Denominator 0 -> rate 0 (no division), and flags insufficient.
 */
export function computeRates(platform: Platform, m: RawMetrics): { rates: DerivedRates; insufficient: boolean } {
  const views = m.views;
  const reach = m.reach;
  const viewsPositive = typeof views === 'number' && views > 0;
  const reachPositive = typeof reach === 'number' && reach > 0;

  const conversionRate = viewsPositive ? (n(m.leads) / (views as number)) * 100 : 0;
  const ctaClickRate = viewsPositive ? (n(m.clickThrough) / (views as number)) * 100 : 0;

  let engagementRate = 0;
  let followRate: number | null = null;

  if (platform === 'tiktok') {
    // TikTok: engagement over views; reach/follows not applicable.
    engagementRate = viewsPositive ? ((n(m.likes) + n(m.comments) + n(m.shares)) / (views as number)) * 100 : 0;
    followRate = null;
  } else {
    // Facebook / Website: engagement and follow over reach.
    engagementRate = reachPositive ? ((n(m.likes) + n(m.comments) + n(m.shares)) / (reach as number)) * 100 : 0;
    followRate = reachPositive ? (n(m.follows) / (reach as number)) * 100 : 0;
  }

  // Insufficient when the primary conversion denominator (views) is zero/absent,
  // or (for non-TikTok) the reach required by engagement/follow is zero/absent.
  const insufficient = !viewsPositive || (platform !== 'tiktok' && !reachPositive);

  return {
    rates: { conversionRate, engagementRate, ctaClickRate, followRate },
    insufficient,
  };
}

export function labelFor(conversionRate: number, insufficient: boolean, cfg: ScoringConfig): PerformanceLabel {
  if (insufficient) return 'INSUFFICIENT_DATA';
  if (conversionRate >= cfg.highThreshold) return 'HIGH_PERFORMER';
  if (conversionRate >= cfg.midThreshold) return 'AVERAGE_PERFORMER';
  return 'LOW_PERFORMER';
}
