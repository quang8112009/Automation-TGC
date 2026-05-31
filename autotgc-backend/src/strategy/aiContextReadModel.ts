/**
 * AI_Prompt_Context read model (design Req 22.2, 22.5).
 *
 * Serves the most recently produced AI_Prompt_Context to the Generation_Service.
 * On cold start (no context row yet) it returns the EMPTY context — never throws
 * — which is exactly the contract Content Pipeline's Default_Context fallback
 * relies on.
 */
import type { PrismaClient } from '@prisma/client';
import {
  asRecord,
  emptyAiPromptContext,
} from '../analytics/types';
import type { AiPromptContextView } from '../analytics/types';

interface AiContextRow {
  contextVersion: string;
  lastUpdatedFromAnalytics: Date | null;
  topPerformingTopics: unknown;
  bestCtaPatterns: unknown;
  avoidTopics: unknown;
  optimalContentLength: unknown;
  toneRecommendations: unknown;
  optimalSchedules: unknown;
}

export class AiContextReadModel {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Latest AI_Prompt_Context, or EMPTY on cold start. Never throws for an
   * absent context (Req 22.5).
   */
  async get(): Promise<AiPromptContextView> {
    const row = await this.prisma.aiPromptContext.findFirst({
      orderBy: { lastUpdatedFromAnalytics: 'desc' },
    });
    if (!row) {
      return emptyAiPromptContext();
    }
    return this.toView(row);
  }

  private toView(row: AiContextRow): AiPromptContextView {
    return {
      contextVersion: row.contextVersion,
      lastUpdatedFromAnalytics: row.lastUpdatedFromAnalytics
        ? row.lastUpdatedFromAnalytics.toISOString()
        : null,
      topPerformingTopics: toTopicArray(row.topPerformingTopics),
      bestCtaPatterns: toCtaArray(row.bestCtaPatterns),
      avoidTopics: toAvoidArray(row.avoidTopics),
      optimalContentLength: toStringRecord(row.optimalContentLength),
      toneRecommendations: toStringRecord(row.toneRecommendations),
      optimalSchedules: toScheduleRecord(row.optimalSchedules),
    };
  }
}

function toTopicArray(value: unknown): Array<{ topic: string; avgConversionRate: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ topic: string; avgConversionRate: number }> = [];
  for (const item of value) {
    const rec = asRecord(item);
    const topic = typeof rec.topic === 'string' ? rec.topic : undefined;
    const avg = typeof rec.avgConversionRate === 'number' ? rec.avgConversionRate : 0;
    if (topic) out.push({ topic, avgConversionRate: avg });
  }
  return out;
}

function toCtaArray(value: unknown): Array<{ cta: string; clickRate: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ cta: string; clickRate: number }> = [];
  for (const item of value) {
    const rec = asRecord(item);
    const cta = typeof rec.cta === 'string' ? rec.cta : undefined;
    const clickRate = typeof rec.clickRate === 'number' ? rec.clickRate : 0;
    if (cta) out.push({ cta, clickRate });
  }
  return out;
}

function toAvoidArray(value: unknown): Array<{ topic: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ topic: string; reason: string }> = [];
  for (const item of value) {
    const rec = asRecord(item);
    const topic = typeof rec.topic === 'string' ? rec.topic : undefined;
    const reason = typeof rec.reason === 'string' ? rec.reason : '';
    if (topic) out.push({ topic, reason });
  }
  return out;
}

function toStringRecord(value: unknown): Record<string, string> {
  const rec = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(rec)) {
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

function toScheduleRecord(value: unknown): Record<string, { bestSlot: string; worstSlot: string }> {
  const rec = asRecord(value);
  const out: Record<string, { bestSlot: string; worstSlot: string }> = {};
  for (const [key, v] of Object.entries(rec)) {
    const inner = asRecord(v);
    const bestSlot = typeof inner.bestSlot === 'string' ? inner.bestSlot : '';
    const worstSlot = typeof inner.worstSlot === 'string' ? inner.worstSlot : '';
    out[key] = { bestSlot, worstSlot };
  }
  return out;
}
