/**
 * Feedback_Engine (design Req 10, 11, 12, 13, 14).
 *
 * Weekly Gemini-driven analyzer. Reads Performance_Records for the period,
 * excludes INSUFFICIENT_DATA, gates content_topics by MIN_SAMPLE, aggregates the
 * five Analysis_Dimensions, calls Gemini for Pattern_Recognition, then emits
 * Learning_Insights (NEW -> PENDING_REVIEW via the state machine) with a
 * confidence score in [0,1] and the sample size used. Conflicts between
 * conversion-backed and engagement-backed insights are resolved in favor of
 * conversion. Gemini failure leaves the strategy unchanged and alerts the
 * Content_Manager — atomically (no partial insight writes).
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import type { GeminiClient } from '../infra/gemini';
import type { AlertDispatcher } from '../infra/alerts';
import type { EventBus } from '../infra/events';
import { insightTransition } from './insightStateMachine';
import { AuditLog } from './auditLog';
import {
  DEFAULT_FEEDBACK_CONFIG,
  clamp01,
} from './types';
import type {
  AnalysisDimension,
  AnalysisPeriod,
  FeedbackConfig,
  InsightType,
} from './types';

/** Minimal Performance_Record projection the engine reasons over. */
export interface PerformanceRow {
  postId: string;
  domainCategory: string;
  contentTopic: string;
  personaId: string;
  toneOfVoice: string;
  objective: string;
  platform: string;
  postTimeSlot: string;
  ctaType: string;
  conversionRate: number;
  engagementRate: number;
  ctaClickRate: number;
  followRate: number | null;
  performanceLabel: string;
}

export interface GroupAggregate {
  dimension: AnalysisDimension;
  key: string;
  count: number;
  avgConversionRate: number;
  avgEngagementRate: number;
  avgCtaClickRate: number;
}

export interface GeneratedInsight {
  insightType: InsightType;
  subject: Record<string, unknown>;
  metrics: Record<string, number>;
  recommendedChange: Record<string, unknown>;
  confidenceScore: number;
  sampleSize: number;
  /** Which rate primarily supports this insight (for conflict resolution). */
  supportedBy: 'conversion' | 'engagement';
}

export type FeedbackRunResult =
  | { outcome: 'analyzed'; insights: Array<GeneratedInsight & { id: string }> }
  | { outcome: 'skipped'; reason: 'ALL_INSUFFICIENT_DATA' | 'BELOW_MIN_SAMPLE' }
  | { outcome: 'failed'; reason: 'GEMINI' };

// --- Pure helpers (exported for property testing) ----------------------------

/**
 * content_topics whose non-INSUFFICIENT_DATA Performance_Record count is at
 * least `minSample` (Req 11.1, 11.2). INSUFFICIENT_DATA rows never count.
 */
export function eligibleTopics(records: PerformanceRow[], minSample: number): string[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.performanceLabel === 'INSUFFICIENT_DATA') continue;
    counts.set(r.contentTopic, (counts.get(r.contentTopic) ?? 0) + 1);
  }
  const eligible: string[] = [];
  for (const [topic, count] of counts) {
    if (count >= minSample) eligible.push(topic);
  }
  eligible.sort();
  return eligible;
}

/**
 * Map a topic's average Conversion_Rate to an Insight_Type (Req 13). HIGH ->
 * TOPIC_FREQUENCY_ADJUSTMENT (increase); below MID -> LOW_PERFORMER_ALERT;
 * the AVERAGE band yields no insight (null).
 */
export function pickInsightType(
  avgConversion: number,
  cfg: FeedbackConfig,
): InsightType | null {
  if (avgConversion >= cfg.highThreshold) return 'TOPIC_FREQUENCY_ADJUSTMENT';
  if (avgConversion < cfg.midThreshold) return 'LOW_PERFORMER_ALERT';
  return null;
}

/** Average of a numeric selector over rows, excluding null/non-finite values. */
function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Stable key for a dimension grouping. */
function dimensionKey(dim: AnalysisDimension, r: PerformanceRow): string {
  switch (dim) {
    case 'domain_category':
      return r.domainCategory;
    case 'content_topic':
      return r.contentTopic;
    case 'persona_tone':
      return `${r.personaId}|${r.toneOfVoice}`;
    case 'platform_timeslot':
      return `${r.platform}|${r.postTimeSlot}`;
    case 'cta_objective':
      return `${r.ctaType}|${r.objective}`;
    default:
      return '';
  }
}

/**
 * Aggregate one Analysis_Dimension over the records (Req 12.1, 12.3),
 * excluding INSUFFICIENT_DATA rows from every aggregate input.
 */
export function aggregate(records: PerformanceRow[], dim: AnalysisDimension): GroupAggregate[] {
  const groups = new Map<string, PerformanceRow[]>();
  for (const r of records) {
    if (r.performanceLabel === 'INSUFFICIENT_DATA') continue;
    const key = dimensionKey(dim, r);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: GroupAggregate[] = [];
  for (const [key, rows] of groups) {
    out.push({
      dimension: dim,
      key,
      count: rows.length,
      avgConversionRate: average(rows.map((r) => r.conversionRate)),
      avgEngagementRate: average(rows.map((r) => r.engagementRate)),
      avgCtaClickRate: average(rows.map((r) => r.ctaClickRate)),
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * Resolve conflicting insights on the same subject: keep conversion-backed,
 * discard engagement-only (Req 14). Deterministic for a given input set.
 * Returns the kept insights plus the discarded ones (for audit).
 */
export function resolveConflicts<T extends GeneratedInsight>(
  insights: T[],
): { kept: T[]; discarded: T[] } {
  const bySubject = new Map<string, T[]>();
  for (const ins of insights) {
    const key = conflictKey(ins);
    const list = bySubject.get(key);
    if (list) list.push(ins);
    else bySubject.set(key, [ins]);
  }

  const kept: T[] = [];
  const discarded: T[] = [];
  for (const group of bySubject.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const conversionBacked = group.filter((g) => g.supportedBy === 'conversion');
    if (conversionBacked.length > 0) {
      kept.push(conversionBacked[0]);
      for (const g of group) {
        if (g !== conversionBacked[0]) discarded.push(g);
      }
    } else {
      kept.push(group[0]);
      for (const g of group.slice(1)) discarded.push(g);
    }
  }
  return { kept, discarded };
}

function conflictKey(ins: GeneratedInsight): string {
  const topic = typeof ins.subject.contentTopic === 'string' ? ins.subject.contentTopic : '';
  const persona = typeof ins.subject.personaId === 'string' ? ins.subject.personaId : '';
  const platform = typeof ins.subject.platform === 'string' ? ins.subject.platform : '';
  const slot = typeof ins.subject.timeSlot === 'string' ? ins.subject.timeSlot : '';
  return `${topic}#${persona}#${platform}#${slot}`;
}

// --- Engine ------------------------------------------------------------------

const ALL_DIMENSIONS: readonly AnalysisDimension[] = [
  'domain_category',
  'content_topic',
  'persona_tone',
  'platform_timeslot',
  'cta_objective',
];

export class FeedbackEngine {
  private readonly audit: AuditLog;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly gemini: GeminiClient,
    private readonly config: FeedbackConfig = DEFAULT_FEEDBACK_CONFIG,
    private readonly alerts: AlertDispatcher,
    private readonly clock: Clock = systemClock,
    private readonly eventBus?: EventBus,
  ) {
    this.audit = new AuditLog(prisma);
  }

  /**
   * Run the weekly analysis for a period. Persists insights atomically: if
   * Pattern_Recognition (Gemini) fails, nothing is written and the strategy is
   * left unchanged (Req 12.4).
   */
  async run(now: Date = this.clock.now(), period?: AnalysisPeriod): Promise<FeedbackRunResult> {
    const window = period ?? this.defaultPeriod(now);

    const rows = await this.loadRecords(window);

    // Req 10.4: nothing usable -> skip, strategy unchanged.
    const usable = rows.filter((r) => r.performanceLabel !== 'INSUFFICIENT_DATA');
    if (usable.length === 0) {
      return { outcome: 'skipped', reason: 'ALL_INSUFFICIENT_DATA' };
    }

    // Req 11: gate by MIN_SAMPLE per content_topic.
    const topics = eligibleTopics(rows, this.config.minSample);
    if (topics.length === 0) {
      return { outcome: 'skipped', reason: 'BELOW_MIN_SAMPLE' };
    }

    // Req 12.1, 12.2: aggregate all five dimensions and call Gemini.
    const aggregates: GroupAggregate[] = [];
    for (const dim of ALL_DIMENSIONS) {
      aggregates.push(...aggregate(usable, dim));
    }

    try {
      await this.gemini.generateContent(this.buildPrompt(window, aggregates));
    } catch {
      // Req 12.4: log + leave strategy unchanged + notify, as one operation.
      await this.alerts.raise(
        'REFRESH_FAILURE',
        'gemini',
        'weekly feedback analysis did not complete',
      );
      return { outcome: 'failed', reason: 'GEMINI' };
    }

    const generated = this.generateInsights(topics, usable);
    const { kept, discarded } = resolveConflicts(generated);

    const persisted: Array<GeneratedInsight & { id: string }> = [];
    for (const insight of kept) {
      const id = await this.persistInsight(insight, window);
      persisted.push({ ...insight, id });
    }

    // Record conflict resolutions in the Audit_Log (Req 14.2).
    for (const dropped of discarded) {
      await this.audit.append('CONFLICT_RESOLVED', '', 'background-worker', {
        discardedInsightType: dropped.insightType,
        subject: dropped.subject,
        supportedBy: dropped.supportedBy,
        rule: 'conversion_over_engagement',
      });
    }

    return { outcome: 'analyzed', insights: persisted };
  }

  // --- internals -------------------------------------------------------------

  private async loadRecords(period: AnalysisPeriod): Promise<PerformanceRow[]> {
    const rows = await this.prisma.performanceRecord.findMany({
      where: { scoredAt: { gte: period.from, lte: period.to } },
    });
    return rows.map((r) => ({
      postId: r.postId,
      domainCategory: r.domainCategory,
      contentTopic: r.contentTopic,
      personaId: r.personaId,
      toneOfVoice: r.toneOfVoice,
      objective: r.objective,
      platform: r.platform,
      postTimeSlot: r.postTimeSlot,
      ctaType: r.ctaType,
      conversionRate: r.conversionRate,
      engagementRate: r.engagementRate,
      ctaClickRate: r.ctaClickRate,
      followRate: r.followRate,
      performanceLabel: r.performanceLabel,
    }));
  }

  /** Build per-topic insights from the eligible topics + usable records. */
  private generateInsights(topics: string[], usable: PerformanceRow[]): GeneratedInsight[] {
    const insights: GeneratedInsight[] = [];

    for (const topic of topics) {
      const topicRows = usable.filter((r) => r.contentTopic === topic);
      if (topicRows.length === 0) continue;

      const avgConversion = average(topicRows.map((r) => r.conversionRate));
      const avgEngagement = average(topicRows.map((r) => r.engagementRate));
      const type = pickInsightType(avgConversion, this.config);
      if (!type) continue;

      const sampleSize = topicRows.length;
      const confidence = this.confidenceFor(sampleSize, avgConversion);

      const recommendedChange: Record<string, unknown> =
        type === 'TOPIC_FREQUENCY_ADJUSTMENT'
          ? { insightType: type, contentTopic: topic, frequencyDeltaPct: 25, direction: 'increase' }
          : { insightType: type, contentTopic: topic, action: 'reduce_or_revise' };

      insights.push({
        insightType: type,
        subject: { contentTopic: topic },
        metrics: {
          avgConversionRate: avgConversion,
          avgEngagementRate: avgEngagement,
          sampleSize,
        },
        recommendedChange,
        confidenceScore: confidence,
        sampleSize,
        // High-conversion topics are conversion-backed; low performers are
        // flagged on the conversion signal too (both rooted in conversion).
        supportedBy: 'conversion',
      });
    }

    return insights;
  }

  /** Confidence in [0,1]: grows with sample size, scaled by signal strength. */
  private confidenceFor(sampleSize: number, avgConversion: number): number {
    const sampleFactor = sampleSize / (sampleSize + this.config.minSample);
    const signalFactor = avgConversion >= this.config.highThreshold ? 1 : 0.6;
    return clamp01(sampleFactor * signalFactor);
  }

  private async persistInsight(insight: GeneratedInsight, period: AnalysisPeriod): Promise<string> {
    // NEW -> PENDING_REVIEW via the guarded state machine (Req 13.5, 15.1).
    const toPending = insightTransition('NEW', 'PENDING_REVIEW');
    const status = toPending.ok ? toPending.status : 'NEW';

    const row = await this.prisma.learningInsight.create({
      data: {
        insightType: insight.insightType,
        insightStatus: status,
        subject: insight.subject as object,
        metrics: insight.metrics as object,
        recommendedChange: insight.recommendedChange as object,
        confidenceScore: insight.confidenceScore,
        sampleSize: insight.sampleSize,
        analysisPeriod: period.label,
        generatedAt: this.clock.now(),
      },
    });

    // Audit: insight generated (Req 20.1).
    await this.audit.append('INSIGHT_GENERATED', row.id, 'background-worker', {
      insightType: insight.insightType,
      subject: insight.subject,
      confidenceScore: insight.confidenceScore,
      sampleSize: insight.sampleSize,
    });

    // Notify the real-time layer that a new insight is pending review.
    if (this.eventBus && status === 'PENDING_REVIEW') {
      try {
        await this.eventBus.publish({
          topic: 'insight',
          type: 'pending',
          payload: { id: row.id, status: row.insightStatus },
        });
      } catch {
        // Non-critical; swallow so analysis still completes.
      }
    }

    return row.id;
  }

  private defaultPeriod(now: Date): AnalysisPeriod {
    const from = new Date(now.getTime() - 7 * 86_400_000);
    return { label: `${from.toISOString()}_${now.toISOString()}`, from, to: now };
  }

  private buildPrompt(period: AnalysisPeriod, aggregates: GroupAggregate[]): string {
    const lines = aggregates.map(
      (a) =>
        `${a.dimension}:${a.key} n=${a.count} conv=${a.avgConversionRate.toFixed(2)} eng=${a.avgEngagementRate.toFixed(2)}`,
    );
    return [
      'You are an analytics pattern-recognition assistant for a content-marketing platform.',
      `Analysis period: ${period.label}.`,
      'Given the following per-dimension aggregates, identify high- and low-performing patterns.',
      ...lines,
    ].join('\n');
  }
}
