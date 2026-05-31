/**
 * Insight_Service (design Req 16, 17, 18).
 *
 * Lists pending insights, opens a single insight with its supporting
 * Performance_Records, and records review decisions. Status changes go ONLY
 * through the Insight_State_Machine (illegal transition -> 409). Approving an
 * insight delegates the strategy mutation to the Strategy_Update_Processor;
 * rejecting requires a non-blank reason (-> 400 otherwise). Every decision is
 * written to the append-only Audit_Log.
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../auth/jwt';
import { systemClock } from '../auth/jwt';
import { ConflictError, NotFoundError, ValidationError } from '../infra/errors';
import { insightTransition } from './insightStateMachine';
import type { InsightStatus } from './insightStateMachine';
import { AuditLog } from './auditLog';
import { asRecord } from './types';
import type { AppliedChange } from '../strategy/strategyUpdateProcessor';

/** The strategy mutation seam (Strategy_Update_Processor implements this). */
export interface StrategyProcessor {
  apply(insight: InsightApplyInput, source?: 'REVIEW' | 'AUTO'): Promise<AppliedChange>;
}

export interface InsightApplyInput {
  id: string;
  insightType: string;
  subject: unknown;
  metrics: unknown;
  recommendedChange: unknown;
  modifiedChange: unknown;
}

/** The routing decision for an insight under the current Auto_Mode setting. */
export type InsightRouting = 'AUTO_APPLY' | 'REVIEW';

/** Maximum auto-appliable posting-frequency adjustment, in percent (design Req 19.2). */
export const AUTO_APPLY_MAX_FREQUENCY_PCT = 30;

/**
 * Auto_Mode routing (design Req 19 / Property 22). Pure, framework-free.
 *
 * While Auto_Mode is disabled, every insight is routed through Review_Mode.
 * While enabled, an insight whose recommended (or modified) change is a
 * posting-frequency adjustment of `<= 30%` (by magnitude) OR a posting
 * time-slot change is routed to `AUTO_APPLY`; any other change is routed to
 * `REVIEW`.
 */
export function routeInsight(
  change: { insightType?: string; frequencyDeltaPct?: number | null; timeSlot?: string | null },
  autoMode: boolean,
): InsightRouting {
  if (!autoMode) return 'REVIEW';

  const delta = change.frequencyDeltaPct;
  const isFrequencyAdjustment =
    change.insightType === 'TOPIC_FREQUENCY_ADJUSTMENT' &&
    typeof delta === 'number' &&
    Number.isFinite(delta) &&
    Math.abs(delta) <= AUTO_APPLY_MAX_FREQUENCY_PCT;

  const isTimeSlotChange =
    change.insightType === 'OPTIMAL_POSTING_SCHEDULE' ||
    (typeof change.timeSlot === 'string' && change.timeSlot.length > 0);

  return isFrequencyAdjustment || isTimeSlotChange ? 'AUTO_APPLY' : 'REVIEW';
}

export interface LearningInsightView {
  insightId: string;
  insightType: string;
  insightStatus: InsightStatus;
  subject: Record<string, unknown>;
  metrics: Record<string, unknown>;
  recommendedChange: Record<string, unknown>;
  modifiedChange: Record<string, unknown> | null;
  confidenceScore: number;
  sampleSize: number;
  analysisPeriod: string;
  generatedAt: Date;
}

interface InsightRecord {
  id: string;
  insightType: string;
  insightStatus: string;
  subject: unknown;
  metrics: unknown;
  recommendedChange: unknown;
  modifiedChange: unknown;
  confidenceScore: number;
  sampleSize: number;
  analysisPeriod: string;
  rejectionReason: string | null;
  generatedAt: Date;
}

export class InsightService {
  private readonly audit: AuditLog;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly strategyProcessor: StrategyProcessor,
    private readonly clock: Clock = systemClock,
  ) {
    this.audit = new AuditLog(prisma);
  }

  /** Paginated PENDING_REVIEW insights (Req 16.1). */
  async listPending(page = 1, limit = 20): Promise<{ items: LearningInsightView[]; total: number }> {
    const take = limit > 0 ? limit : 20;
    const skip = (page > 0 ? page - 1 : 0) * take;
    const [rows, total] = await Promise.all([
      this.prisma.learningInsight.findMany({
        where: { insightStatus: 'PENDING_REVIEW' },
        orderBy: { generatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.learningInsight.count({ where: { insightStatus: 'PENDING_REVIEW' } }),
    ]);
    return { items: rows.map((r) => this.toView(r)), total };
  }

  /** Open one insight with the supporting Performance_Records (Req 16.2). */
  async open(id: string): Promise<{
    insight: LearningInsightView;
    supportingRecords: Array<{ postId: string; contentTopic: string; performanceLabel: string; conversionRate: number }>;
  }> {
    const row = await this.requireInsight(id);
    const subject = asRecord(row.subject);
    const topic = typeof subject.contentTopic === 'string' ? subject.contentTopic : undefined;

    const supporting = topic
      ? await this.prisma.performanceRecord.findMany({
          where: { contentTopic: topic },
          orderBy: { scoredAt: 'desc' },
          take: 100,
        })
      : [];

    return {
      insight: this.toView(row),
      supportingRecords: supporting.map((s) => ({
        postId: s.postId,
        contentTopic: s.contentTopic,
        performanceLabel: s.performanceLabel,
        conversionRate: s.conversionRate,
      })),
    };
  }

  /**
   * Approve (Req 17): non-PENDING_REVIEW -> 409; otherwise transition to
   * APPROVED, apply the (possibly modified) change via the processor, audit it.
   */
  async approve(id: string, actor: string): Promise<{ status: 'APPROVED'; applied: AppliedChange }> {
    const row = await this.requireInsight(id);
    const result = insightTransition(row.insightStatus as InsightStatus, 'APPROVED');
    if (!result.ok) {
      throw new ConflictError('Insight is not pending review', 'INSIGHT_NOT_PENDING');
    }

    await this.prisma.learningInsight.update({
      where: { id },
      data: { insightStatus: 'APPROVED' },
    });

    const applied = await this.strategyProcessor.apply(
      {
        id: row.id,
        insightType: row.insightType,
        subject: row.subject,
        metrics: row.metrics,
        recommendedChange: row.recommendedChange,
        modifiedChange: row.modifiedChange,
      },
      'REVIEW',
    );

    await this.audit.append('INSIGHT_APPROVED', id, actor, {
      insightType: row.insightType,
      touched: applied.touched,
    });

    return { status: 'APPROVED', applied };
  }

  /**
   * Reject (Req 18.1–18.3): blank reason -> 400; non-PENDING_REVIEW -> 409;
   * otherwise transition to REJECTED, store the reason, audit it.
   */
  async reject(id: string, actor: string, reason: string): Promise<{ status: 'REJECTED' }> {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError('A rejection reason is required', 'MISSING_REJECTION_REASON');
    }
    const row = await this.requireInsight(id);
    const result = insightTransition(row.insightStatus as InsightStatus, 'REJECTED');
    if (!result.ok) {
      throw new ConflictError('Insight is not pending review', 'INSIGHT_NOT_PENDING');
    }

    await this.prisma.learningInsight.update({
      where: { id },
      data: { insightStatus: 'REJECTED', rejectionReason: reason.trim() },
    });

    await this.audit.append('INSIGHT_REJECTED', id, actor, {
      insightType: row.insightType,
      reason: reason.trim(),
    });

    return { status: 'REJECTED' };
  }

  /**
   * Modify (Req 18.4): persist an edited recommended change on a PENDING_REVIEW
   * insight; on approval the modified change is applied. Editing a
   * non-PENDING_REVIEW insight -> 409.
   */
  async modify(id: string, edited: Record<string, unknown>): Promise<LearningInsightView> {
    const row = await this.requireInsight(id);
    if (row.insightStatus !== 'PENDING_REVIEW') {
      throw new ConflictError('Only pending insights can be modified', 'INSIGHT_NOT_PENDING');
    }
    const updated = await this.prisma.learningInsight.update({
      where: { id },
      data: { modifiedChange: edited as object },
    });
    return this.toView(updated);
  }

  // --- internals -------------------------------------------------------------

  private async requireInsight(id: string): Promise<InsightRecord> {
    const row = await this.prisma.learningInsight.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundError('Insight not found', 'INSIGHT_NOT_FOUND');
    }
    return row;
  }

  private toView(row: InsightRecord): LearningInsightView {
    return {
      insightId: row.id,
      insightType: row.insightType,
      insightStatus: row.insightStatus as InsightStatus,
      subject: asRecord(row.subject),
      metrics: asRecord(row.metrics),
      recommendedChange: asRecord(row.recommendedChange),
      modifiedChange: row.modifiedChange === null || row.modifiedChange === undefined
        ? null
        : asRecord(row.modifiedChange),
      confidenceScore: row.confidenceScore,
      sampleSize: row.sampleSize,
      analysisPeriod: row.analysisPeriod,
      generatedAt: row.generatedAt,
    };
  }
}
