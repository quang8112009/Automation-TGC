/**
 * Shared types + tiny JSON-narrowing helpers for the Analytics & Feedback Loop.
 *
 * Pure, framework-free. These types mirror the design's domain contracts
 * (Content_Features, Insight_Type, AI_Prompt_Context) without re-exporting the
 * existing scoring / insight-state-machine modules (those are imported directly).
 */
import { isRecord } from '../platforms/narrow';
import type { Platform } from './scoring';

/** The five Insight_Types (design Req 13). */
export type InsightType =
  | 'TOPIC_FREQUENCY_ADJUSTMENT'
  | 'PERSONA_TONE_OPTIMIZATION'
  | 'OPTIMAL_POSTING_SCHEDULE'
  | 'LOW_PERFORMER_ALERT'
  | 'PLATFORM_CONTENT_FIT';

/** The five Pattern_Recognition dimensions (design Req 12.1). */
export type AnalysisDimension =
  | 'domain_category'
  | 'content_topic'
  | 'persona_tone'
  | 'platform_timeslot'
  | 'cta_objective';

/** Audit ledger event types (design Req 20; ai-reporting Req 3.5). */
export type AuditEventType =
  | 'INSIGHT_GENERATED'
  | 'INSIGHT_APPROVED'
  | 'INSIGHT_REJECTED'
  | 'CONFLICT_RESOLVED'
  | 'STRATEGY_CHANGE_APPLIED'
  | 'REPORT_APPROVED';

/** Eleven Content_Features extracted from a draft/scheduled post (design Req 9.1). */
export interface ContentFeatures {
  domainCategory: string;
  contentTopic: string;
  personaId: string;
  toneOfVoice: string;
  objective: string;
  platform: Platform;
  postTimeSlot: string;
  contentLength: number;
  hasCta: boolean;
  ctaType: string;
  mediaType: string;
}

/** Analysis window for a Feedback_Engine run. */
export interface AnalysisPeriod {
  label: string;
  from: Date;
  to: Date;
}

/** Feedback gating + threshold config (design Req 11.4, 8.4). */
export interface FeedbackConfig {
  minSample: number;
  highThreshold: number;
  midThreshold: number;
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  minSample: 5,
  highThreshold: 5,
  midThreshold: 2,
};

/** Typed read view of the AI_Prompt_Context produced for the Generation_Service. */
export interface AiPromptContextView {
  contextVersion: string;
  lastUpdatedFromAnalytics: string | null;
  topPerformingTopics: Array<{ topic: string; avgConversionRate: number }>;
  bestCtaPatterns: Array<{ cta: string; clickRate: number }>;
  avoidTopics: Array<{ topic: string; reason: string }>;
  optimalContentLength: Record<string, string>;
  toneRecommendations: Record<string, string>;
  optimalSchedules: Record<string, { bestSlot: string; worstSlot: string }>;
}

/** Cold-start context (design Req 22.5): all arrays empty, no timestamp. */
export const EMPTY_AI_PROMPT_CONTEXT: AiPromptContextView = {
  contextVersion: '',
  lastUpdatedFromAnalytics: null,
  topPerformingTopics: [],
  bestCtaPatterns: [],
  avoidTopics: [],
  optimalContentLength: {},
  toneRecommendations: {},
  optimalSchedules: {},
};

/** Fresh deep clone of the empty context so callers never share mutable state. */
export function emptyAiPromptContext(): AiPromptContextView {
  return {
    contextVersion: '',
    lastUpdatedFromAnalytics: null,
    topPerformingTopics: [],
    bestCtaPatterns: [],
    avoidTopics: [],
    optimalContentLength: {},
    toneRecommendations: {},
    optimalSchedules: {},
  };
}

// --- JSON narrowing helpers (Prisma Json fields arrive as `unknown`-ish) ------

/** Narrow an unknown (Prisma Json) value to a plain object, else {}. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Read a non-empty string property, else undefined. */
export function getStr(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Read a finite number property, else undefined. */
export function getNum(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Clamp a value into the [0, 1] interval (used for confidence scores). */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
