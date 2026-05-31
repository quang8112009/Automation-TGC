/**
 * Marketing_Autopilot_Workflow — the data-driven, performance-first loop that
 * ties the already-built marketing pieces into ONE WorkflowDefinition for the
 * existing WorkflowOrchestrator saga engine (customer: Thanh Giang — Vietnamese
 * labor-export / XKLĐ).
 *
 *   research → plan → generate (multi-format + brand assets) → review_gate
 *   (human review) → schedule → summary
 *
 * CORE PRINCIPLE (shapes the logic, not just a comment): the autopilot does NOT
 * optimize for "post a lot". It prioritizes HIGH-PERFORMANCE content that drives
 * traffic / follow / lead:
 *   - The planner + multi-format generator already consume the analytics
 *     AiPromptContext, so generated copy is biased toward what performs.
 *   - `sequenceForPerformance` (pure) generates the highest-leverage plan items
 *     FIRST, so when AI is rate-limited / partially failing the best items win.
 *   - A human REVIEW GATE pauses the run after generation; only drafts a human
 *     APPROVES are scheduled — volume never bypasses the quality bar.
 *
 * Resilience (mirrors content/contentPipelineWorkflow.ts): the per-item generate
 * loop treats a Gemini 502 (AI_NOT_CONFIGURED) — or ANY per-item error — as a
 * SOFT skip (recorded with a reason) rather than a hard run failure, so one bad
 * item never sinks the whole batch.
 *
 * This module is PURE data + closures over injected services — no Fastify, no
 * direct Prisma. `assetKindForFormat`, `performanceWeight`, and
 * `sequenceForPerformance` are pure + exported for property testing. It REUSES
 * WorkflowOrchestrator; it does not build a new saga engine.
 */
import type { ContentPlanItem } from '@prisma/client';
import type { AgentContext, AgentResult } from '../../agents/agent';
import { readString, readStringArray } from '../../agents/agent';
import { AppError } from '../../infra/errors';
import type { StepDefinition, WorkflowDefinition } from '../../orchestration/types';
import type { TrendResearchService } from '../research/trendResearchService';
import type { ContentPlanner } from '../planning/contentPlanner';
import type { MultiFormatGenerator } from '../content/multiFormatGenerator';
import type { AssetGenerator } from '../assets/assetGenerator';
import type { SchedulingService } from '../../content/schedulingService';
import { CONTENT_FORMATS } from '../content/formats';
import type { ContentFormat } from '../content/formats';
import type { AssetKind } from '../assets/assetKinds';

/** Workflow type discriminator persisted on WorkflowRun.type. */
export const AUTOPILOT_TYPE = 'marketing_autopilot';

/** Draft platforms the schedulingService actually accepts (Phase 1). */
const DRAFT_PLATFORMS: ReadonlySet<string> = new Set<string>(['facebook', 'tiktok', 'website']);

/** Map an autopilot channel to a schedulingService DraftPlatform. */
export function channelToPlatform(channel: string): string | null {
  switch (channel) {
    case 'facebook':
      return 'facebook';
    case 'tiktok':
      return 'tiktok';
    case 'website':
      return 'website';
    // youtube / zalo / email are NOT DraftPlatforms in schedulingService yet.
    default:
      return null;
  }
}

/** True iff a channel maps to a schedulingService DraftPlatform. */
export function isDraftPlatformChannel(channel: string): boolean {
  return DRAFT_PLATFORMS.has(channelToPlatform(channel) ?? '');
}

/**
 * PURE, TOTAL format → brand-asset-kind map. Defined for every ContentFormat and
 * safe for arbitrary strings (defaults to 'image'). Always returns a valid
 * AssetKind (thumbnail | infographic | poster | short_video | image):
 *   VIDEO_SCRIPT     → short_video  (TikTok / Reels / Shorts cut)
 *   SEO_ARTICLE      → infographic  (visual summary of the long-form article)
 *   EMAIL            → thumbnail    (header/hero image for the mail)
 *   FANPAGE_CAPTION  → thumbnail    (feed link/preview card)
 *   CARE_MESSAGE     → image        (simple square care visual)
 *   CHATBOT_FAQ      → image        (generic square)
 *   GENERIC          → image
 */
const FORMAT_ASSET_KIND: Readonly<Record<ContentFormat, AssetKind>> = {
  GENERIC: 'image',
  SEO_ARTICLE: 'infographic',
  FANPAGE_CAPTION: 'thumbnail',
  VIDEO_SCRIPT: 'short_video',
  EMAIL: 'thumbnail',
  CARE_MESSAGE: 'image',
  CHATBOT_FAQ: 'image',
};

/** Pure, total: the brand-asset kind to produce for a content format. */
export function assetKindForFormat(format: string): AssetKind {
  // Own-property guard: a plain-object index lookup would otherwise return
  // inherited Object.prototype members (e.g. 'toString', 'constructor') for
  // those literal strings instead of falling through to the 'image' default.
  return Object.prototype.hasOwnProperty.call(FORMAT_ASSET_KIND, format)
    ? (FORMAT_ASSET_KIND as Record<string, AssetKind>)[format]
    : 'image';
}

/**
 * PURE performance weight for sequencing — higher = generate sooner (the core
 * "performance not volume" rule). Weights favor formats/channels with the
 * strongest traffic/follow/lead leverage for XKLĐ:
 *   - short video (VIDEO_SCRIPT) + SEO article are the top traffic/lead drivers,
 *   - then fanpage captions (reach/follow), then nurture (email/care/faq).
 * Deterministic and bounded; never throws.
 */
export function performanceWeight(format: string): number {
  switch (format) {
    case 'VIDEO_SCRIPT':
      return 100;
    case 'SEO_ARTICLE':
      return 90;
    case 'FANPAGE_CAPTION':
      return 70;
    case 'EMAIL':
      return 50;
    case 'CARE_MESSAGE':
      return 40;
    case 'CHATBOT_FAQ':
      return 30;
    default:
      return 20;
  }
}

/**
 * PURE: order plan items so the highest-leverage content is produced FIRST.
 * Stable: ties (equal weight) keep the planner's original orderIndex. Returns a
 * new array; the input is not mutated.
 */
export function sequenceForPerformance<T extends { format: string; orderIndex: number }>(
  items: readonly T[],
): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        performanceWeight(b.item.format) - performanceWeight(a.item.format) ||
        a.item.orderIndex - b.item.orderIndex ||
        a.i - b.i,
    )
    .map((x) => x.item);
}

/** A per-item skip record (soft skip — never fails the run). */
export interface SkippedItem {
  itemId: string;
  channel: string;
  format: string;
  reason: string;
}

/** Services + options the autopilot workflow closes over. */
export interface AutopilotDeps {
  trendResearch: TrendResearchService;
  contentPlanner: ContentPlanner;
  multiFormatGenerator: MultiFormatGenerator;
  assetGenerator: AssetGenerator;
  schedulingService: SchedulingService;
  /**
   * When true (default), a human REVIEW GATE pauses the run after generation
   * (WAITING_APPROVAL) before anything is scheduled. Set false for a fully
   * autonomous loop (generation still only schedules human-APPROVED drafts).
   */
  requireApproval?: boolean;
}

/**
 * Build the marketing autopilot WorkflowDefinition. Each step closes over the
 * injected services and reads/writes ctx.variables. The review gate is a
 * SEPARATE zero-work step placed AFTER generate and BEFORE schedule so the
 * orchestrator pauses there and resume() opens it.
 */
export function buildAutopilotWorkflow(deps: AutopilotDeps): WorkflowDefinition {
  const requireApproval = deps.requireApproval ?? true;
  const steps: StepDefinition[] = [
    buildResearchStep(deps),
    buildPlanStep(deps),
    buildGenerateStep(deps),
    buildReviewGateStep(requireApproval),
    buildScheduleStep(deps),
    buildSummaryStep(),
  ];
  return { type: AUTOPILOT_TYPE, steps };
}

// ---- Steps ------------------------------------------------------------------

/** research: ensure the market has trends to plan from (else discover them). */
function buildResearchStep(deps: AutopilotDeps): StepDefinition {
  return {
    name: 'research',
    run: async (ctx: AgentContext): Promise<AgentResult> => {
      const market = readString(ctx.variables, 'market');
      if (!market) return { ok: false, error: 'market is required in context' };

      const adopted = await deps.trendResearch.adoptedTopics(market);
      const existing = await deps.trendResearch.list(market);
      const discovered = existing.filter((s) => s.status === 'DISCOVERED');

      let trendsCount = existing.length;
      let researched = false;
      // Only research when nothing usable exists yet (adopted or discovered).
      if (adopted.length === 0 && discovered.length === 0) {
        const result = await deps.trendResearch.research(market);
        trendsCount = result.created.length;
        researched = true;
      }
      return { ok: true, output: { trendsCount, researched } };
    },
  };
}

/** plan: produce a multi-channel ContentPlan for the market + period. */
function buildPlanStep(deps: AutopilotDeps): StepDefinition {
  return {
    name: 'plan',
    run: async (ctx: AgentContext): Promise<AgentResult> => {
      const market = readString(ctx.variables, 'market');
      const objective = readString(ctx.variables, 'objective');
      const periodFrom = readString(ctx.variables, 'periodFrom');
      const periodTo = readString(ctx.variables, 'periodTo');
      if (!market || !objective || !periodFrom || !periodTo) {
        return { ok: false, error: 'market, objective, periodFrom and periodTo are required' };
      }
      const channels = readStringArray(ctx.variables, 'channels');
      const createdBy = readString(ctx.variables, 'createdBy');

      const plan = await deps.contentPlanner.generatePlan({
        market,
        objective,
        periodFrom,
        periodTo,
        channels: channels.length > 0 ? channels : undefined,
        createdBy: createdBy ?? null,
      });
      return { ok: true, output: { planId: plan.id, itemCount: plan.items.length } };
    },
  };
}

/**
 * generate: for each plan item (highest-leverage first), generate a multi-format
 * draft and a best-effort brand asset. Each item is wrapped in try/catch — a
 * Gemini 502 or ANY per-item error becomes a SOFT skip (recorded), never a hard
 * step failure.
 */
function buildGenerateStep(deps: AutopilotDeps): StepDefinition {
  return {
    name: 'generate',
    run: async (ctx: AgentContext): Promise<AgentResult> => {
      const planId = readString(ctx.variables, 'planId');
      if (!planId) return { ok: false, error: 'planId is missing from context' };

      const market = readString(ctx.variables, 'market');
      const domainName = readString(ctx.variables, 'domainName');
      const personaIds = readStringArray(ctx.variables, 'personaIds');

      const items = sequenceForPerformance(await deps.contentPlanner.listItems(planId));

      const draftIds: string[] = [];
      const skippedItems: SkippedItem[] = [];
      let generated = 0;

      for (const item of items) {
        try {
          const result = await deps.multiFormatGenerator.generate({
            format: item.format,
            domainName,
            personaIds,
            objective: item.objective,
            market: market ?? item.market,
            topic: item.topic || undefined,
            keyword: item.keyword || undefined,
            planItemId: item.id,
          });
          const draftId = result.draft.id;
          await deps.contentPlanner.markItem(item.id, 'GENERATED', draftId);
          generated += 1;
          draftIds.push(draftId);

          // Brand asset is best-effort: an asset failure must not undo generation.
          try {
            await deps.assetGenerator.generateForDraft(draftId, assetKindForFormat(item.format));
          } catch {
            // best-effort; the draft still stands as GENERATED.
          }
        } catch (err) {
          skippedItems.push({
            itemId: item.id,
            channel: item.channel,
            format: item.format,
            reason: errorReason(err),
          });
        }
      }

      return {
        ok: true,
        output: { generated, skipped: skippedItems.length, draftIds, skippedItems },
      };
    },
  };
}

/**
 * review_gate: a SEPARATE zero-work approval gate. When requireApproval is true
 * the orchestrator pauses here (WAITING_APPROVAL) until resume() opens it; when
 * false it is a transparent no-op pass.
 */
function buildReviewGateStep(requireApproval: boolean): StepDefinition {
  return {
    name: 'review_gate',
    requiresApproval: requireApproval,
    run: async (): Promise<AgentResult> => ({ ok: true }),
  };
}

/**
 * schedule: fan out only GENERATED items on a real DraftPlatform channel whose
 * draft is APPROVED. The schedulingService is the single source of truth for the
 * approval gate — it throws 409 DRAFT_NOT_APPROVED for non-approved drafts, which
 * we treat as a recorded "left as GENERATED" (skippedUnapproved), never a hard
 * failure. Channels outside {facebook,tiktok,website} are recorded skippedChannel
 * (scheduling them is future work once schedulingService supports them).
 */
function buildScheduleStep(deps: AutopilotDeps): StepDefinition {
  return {
    name: 'schedule',
    run: async (ctx: AgentContext): Promise<AgentResult> => {
      const planId = readString(ctx.variables, 'planId');
      if (!planId) return { ok: false, error: 'planId is missing from context' };

      const items = await deps.contentPlanner.listItems(planId);

      let scheduled = 0;
      let skippedUnapproved = 0;
      let skippedChannel = 0;
      let skippedRejected = 0;
      const scheduledItems: string[] = [];

      for (const item of items) {
        if (item.status !== 'GENERATED' || !item.draftId) continue;

        const platform = channelToPlatform(item.channel);
        if (!platform) {
          // youtube / zalo / email: GENERATED + asset produced, but NOT scheduled.
          skippedChannel += 1;
          continue;
        }

        const iso = isoOrNull(item.targetDate);
        if (!iso) {
          skippedRejected += 1;
          continue;
        }

        try {
          const result = await deps.schedulingService.schedule({
            draftId: item.draftId,
            platforms: [platform],
            scheduledAt: { [platform]: iso },
          });
          if (result.created.length > 0) {
            scheduled += 1;
            scheduledItems.push(item.id);
            await deps.contentPlanner.markItem(item.id, 'SCHEDULED', item.draftId);
          } else {
            // Approved but every platform gate rejected (e.g. NOT_FUTURE).
            skippedRejected += 1;
          }
        } catch (err) {
          if (err instanceof AppError && err.code === 'DRAFT_NOT_APPROVED') {
            // Not approved by a human yet — leave as GENERATED (recorded).
            skippedUnapproved += 1;
          } else {
            // Any other scheduling error is recorded, never hard-fails the run.
            skippedRejected += 1;
          }
        }
      }

      return {
        ok: true,
        output: { scheduled, skippedUnapproved, skippedChannel, skippedRejected, scheduledItems },
      };
    },
  };
}

/** summary: assemble the final autopilot result into the run context. */
function buildSummaryStep(): StepDefinition {
  return {
    name: 'summary',
    run: async (ctx: AgentContext): Promise<AgentResult> => {
      const summary = {
        market: readString(ctx.variables, 'market') ?? null,
        planId: readString(ctx.variables, 'planId') ?? null,
        generated: readNumber(ctx.variables, 'generated'),
        scheduled: readNumber(ctx.variables, 'scheduled'),
        skipped: readNumber(ctx.variables, 'skipped'),
      };
      return { ok: true, output: { summary } };
    },
  };
}

// ---- Pure helpers -----------------------------------------------------------

/** Best-effort, human-readable reason for a per-item failure (AppError-aware). */
function errorReason(err: unknown): string {
  if (err instanceof AppError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Read a finite number from the workflow variables (0 when absent/ill-typed). */
function readNumber(variables: Record<string, unknown>, key: string): number {
  const v = variables[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Coerce a Date | ISO string | null into an ISO string, or null when unusable. */
function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Exported for tests: the canonical content-format list this map covers. */
export { CONTENT_FORMATS };
export type { ContentPlanItem };
