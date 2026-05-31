/**
 * Strategy_Update_Processor (design Req 21, 22).
 *
 * The SINGLE SOURCE OF TRUTH for strategy mutation from an insight. It is the
 * only component permitted to change Content_Calendar topic frequency,
 * Content_Persona.recommendedTone, and the AI_Prompt_Context as a result of an
 * applied insight. It touches ONLY the targets relevant to the insight type,
 * always updates the affected AI_Prompt_Context fields, and writes an
 * STRATEGY_CHANGE_APPLIED audit entry for every change.
 *
 * There is no Content_Calendar frequency table in the Phase-1 schema, so a
 * TOPIC_FREQUENCY_ADJUSTMENT is recorded as intent inside the AI_Prompt_Context
 * (topPerformingTopics) plus the Audit_Log, rather than mutating a calendar row.
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import { AuditLog } from '../analytics/auditLog';
import {
  asRecord,
  getNum,
  getStr,
  emptyAiPromptContext,
} from '../analytics/types';
import type { AiPromptContextView, InsightType } from '../analytics/types';

export type StrategyTarget = 'CALENDAR' | 'PERSONA' | 'AI_CONTEXT';

export interface AppliedChange {
  insightId: string;
  touched: StrategyTarget[];
  auditEntryId: string;
}

interface InsightRow {
  id: string;
  insightType: string;
  subject: unknown;
  metrics: unknown;
  recommendedChange: unknown;
  modifiedChange: unknown;
}

const CONTEXT_VERSION_PREFIX = 'v';

export class StrategyUpdateProcessor {
  private readonly audit: AuditLog;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock = systemClock,
  ) {
    this.audit = new AuditLog(prisma);
  }

  /**
   * Apply an approved insight's (possibly modified) recommended change. Touches
   * only the type-relevant target(s); always refreshes the AI_Prompt_Context;
   * records STRATEGY_CHANGE_APPLIED (Req 21.2–21.5, 20.3).
   */
  async apply(insight: InsightRow, source: 'REVIEW' | 'AUTO' = 'REVIEW'): Promise<AppliedChange> {
    const type = insight.insightType as InsightType;
    // The modified change supersedes the original when present (Req 18.4).
    const change = asRecord(insight.modifiedChange ?? insight.recommendedChange);
    const subject = asRecord(insight.subject);
    const touched: StrategyTarget[] = [];

    if (type === 'PERSONA_TONE_OPTIMIZATION') {
      const personaId = getStr(change, 'personaId') ?? getStr(subject, 'personaId');
      const tone = getStr(change, 'recommendedTone');
      if (personaId && tone) {
        await this.prisma.contentPersona.update({
          where: { id: personaId },
          data: { recommendedTone: tone },
        });
        touched.push('PERSONA');
      }
    }

    if (type === 'TOPIC_FREQUENCY_ADJUSTMENT') {
      // No calendar-frequency table in Phase 1; intent is captured in the
      // AI_Prompt_Context (topPerformingTopics) and the Audit_Log below.
      touched.push('CALENDAR');
    }

    // Every applied insight refreshes the affected AI_Prompt_Context fields.
    await this.refreshContextWith(insight);
    touched.push('AI_CONTEXT');

    const entry = await this.audit.append('STRATEGY_CHANGE_APPLIED', insight.id, sourceActor(source), {
      insightType: type,
      source,
      appliedChange: change,
      subject,
      touched,
    });

    return { insightId: insight.id, touched, auditEntryId: entry.id };
  }

  /**
   * Produce the AI_Prompt_Context from the set of applied insights (Req 22.1,
   * 22.3, 22.4). Pure assembly: derives avoidTopics from applied
   * LOW_PERFORMER_ALERTs and topPerformingTopics from applied HIGH patterns.
   */
  produceAiContext(appliedInsights: InsightRow[], now: Date = this.clock.now()): AiPromptContextView {
    const ctx = emptyAiPromptContext();
    ctx.contextVersion = `${CONTEXT_VERSION_PREFIX}${now.getTime()}`;
    ctx.lastUpdatedFromAnalytics = now.toISOString();

    for (const insight of appliedInsights) {
      const type = insight.insightType as InsightType;
      const subject = asRecord(insight.subject);
      const metrics = asRecord(insight.metrics);
      const change = asRecord(insight.modifiedChange ?? insight.recommendedChange);
      const topic = getStr(change, 'contentTopic') ?? getStr(subject, 'contentTopic');

      if (type === 'TOPIC_FREQUENCY_ADJUSTMENT' && topic) {
        const avg = getNum(metrics, 'avgConversionRate') ?? 0;
        if (!ctx.topPerformingTopics.some((t) => t.topic === topic)) {
          ctx.topPerformingTopics.push({ topic, avgConversionRate: avg });
        }
      }

      if (type === 'LOW_PERFORMER_ALERT' && topic) {
        if (!ctx.avoidTopics.some((t) => t.topic === topic)) {
          ctx.avoidTopics.push({ topic, reason: 'low_performer' });
        }
      }

      if (type === 'PERSONA_TONE_OPTIMIZATION') {
        const personaId = getStr(change, 'personaId') ?? getStr(subject, 'personaId');
        const tone = getStr(change, 'recommendedTone');
        if (personaId && tone) {
          ctx.toneRecommendations[personaId] = tone;
        }
      }

      if (type === 'OPTIMAL_POSTING_SCHEDULE') {
        const platform = getStr(change, 'platform') ?? getStr(subject, 'platform');
        const bestSlot = getStr(change, 'bestSlot') ?? getStr(change, 'timeSlot');
        if (platform && bestSlot) {
          ctx.optimalSchedules[platform] = {
            bestSlot,
            worstSlot: getStr(change, 'worstSlot') ?? '',
          };
        }
      }

      if (type === 'PLATFORM_CONTENT_FIT') {
        const platform = getStr(change, 'platform') ?? getStr(subject, 'platform');
        const length = getStr(change, 'optimalContentLength');
        if (platform && length) {
          ctx.optimalContentLength[platform] = length;
        }
      }
    }

    return ctx;
  }

  // --- internals -------------------------------------------------------------

  /**
   * Recompute the AI_Prompt_Context from ALL currently-approved insights and
   * upsert the single context row (Req 22.1). Keeping it derived-from-source
   * means the read model always reflects the full approved set.
   */
  private async refreshContextWith(_justApplied: InsightRow): Promise<void> {
    const approved = await this.prisma.learningInsight.findMany({
      where: { insightStatus: 'APPROVED' },
      orderBy: { generatedAt: 'asc' },
    });

    const rows: InsightRow[] = approved.map((r) => ({
      id: r.id,
      insightType: r.insightType,
      subject: r.subject,
      metrics: r.metrics,
      recommendedChange: r.recommendedChange,
      modifiedChange: r.modifiedChange,
    }));

    const ctx = this.produceAiContext(rows);
    await this.upsertContext(ctx);
  }

  /** Upsert the single AI_Prompt_Context row (latest wins). */
  private async upsertContext(ctx: AiPromptContextView): Promise<void> {
    const existing = await this.prisma.aiPromptContext.findFirst({
      orderBy: { lastUpdatedFromAnalytics: 'desc' },
    });

    const data = {
      contextVersion: ctx.contextVersion,
      lastUpdatedFromAnalytics: ctx.lastUpdatedFromAnalytics
        ? new Date(ctx.lastUpdatedFromAnalytics)
        : null,
      topPerformingTopics: ctx.topPerformingTopics as object,
      bestCtaPatterns: ctx.bestCtaPatterns as object,
      avoidTopics: ctx.avoidTopics as object,
      optimalContentLength: ctx.optimalContentLength as object,
      toneRecommendations: ctx.toneRecommendations as object,
      optimalSchedules: ctx.optimalSchedules as object,
    };

    if (existing) {
      await this.prisma.aiPromptContext.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.aiPromptContext.create({ data });
    }
  }
}

function sourceActor(source: 'REVIEW' | 'AUTO'): string {
  return source === 'AUTO' ? 'AUTO_MODE' : 'background-worker';
}
