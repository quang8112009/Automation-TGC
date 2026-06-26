/**
 * Scheduled-job bootstrap — wires the platform automation that the specs require
 * to run on a cadence (Foundation Req 11.1/17.x, Content Req 11.4, Analytics Req 12.2):
 *   - Token refresh cycle           — every 12 hours
 *   - Analytics collection cycle    — every 6 hours
 *   - Publishing due-scan + publish — every minute (picks up Scheduled posts due now)
 *   - Weekly feedback analysis      — Sunday 00:00
 *
 * Each job is registered on the NodeCronScheduler, which catches and logs job
 * errors (job name + timestamp) so one failing run never crashes the process.
 * Intervals are configurable via env so deployments (and tests) can override them.
 *
 * AI MARKETING AUTOPILOT (opt-in; OFF by default) — see `optionalJobsToRegister`:
 *   - auto-market-research  — Mon 02:00 (CRON_AUTO_RESEARCH; AUTOPILOT_AUTO_RESEARCH)
 *   - auto-content-plan     — Mon 03:00 (CRON_AUTO_PLAN;     AUTOPILOT_AUTO_PLAN)
 *   - asset-render-retry    — every 15m (CRON_ASSET_RETRY;   AUTOPILOT_ASSET_RETRY)
 *
 * These do real, possibly-costly AI work, so they are OPT-IN: each is only
 * REGISTERED when its enable flag is truthy (so they never surprise-run or burn
 * quota). They also respect REVIEW MODE — auto-content-plan only creates DRAFT
 * plans (a human still reviews/activates/generates); nothing is auto-published.
 */
import type { PrismaClient } from '@prisma/client';
import type { SecretLoader } from './secrets';
import type { Logger } from './logger';
import { NodeCronScheduler } from './scheduler';
import type { Scheduler } from './scheduler';
import type { TokenManager } from '../tokens/tokenManager';
import { CollectionService } from '../analytics/collectionService';
import { FeedbackEngine } from '../analytics/feedbackEngine';
import { ScoringService } from '../analytics/scoringService';
import { PublishingWorker } from '../content/publishingWorker';
import type { AdapterRegistry } from '../platforms/registry';
import type { AlertDispatcher } from './alerts';
import { AiTextClient } from './aiTextClient';
import { parseAiTextConfigFromSecrets, parseMaxTokensEnv } from './aiTextConfig';
import { getEventBus } from './events';
import { ReportService } from '../reporting/reportService';
import { registerReportJobs } from '../reporting/reportScheduler';
import { TimelineAgent } from '../applications/timelineAgent';
import { NotificationService } from '../oversight/notificationService';
import {
  RetentionPurgeService,
  parseRetentionMonths,
  DEFAULT_RETENTION_CONFIG,
} from '../privacy/retentionPurgeService';
import { createPublishQueue, createScoreQueue, enqueuePublish, enqueueScore } from '../queues/queues';
// --- AI marketing autopilot (opt-in scheduled jobs) collaborators ------------
import { isMarket } from '../marketing/markets';
import type { Market } from '../marketing/markets';
import { TrendResearchService } from '../marketing/research/trendResearchService';
import { ContentPlanner } from '../marketing/planning/contentPlanner';
import { KnowledgeBrandProvider } from '../marketing/brandKnowledge';
import { KnowledgeService } from '../recruitment/knowledge/knowledgeService';
import { AssetGenerator } from '../marketing/assets/assetGenerator';
import { specFromAsset } from '../marketing/assets/renderRoutes';
import { isAssetKind } from '../marketing/assets/assetKinds';
import { createMediaRenderProvider } from '../marketing/assets/providers/mediaRenderProvider';

export interface JobDeps {
  prisma: PrismaClient;
  secrets: SecretLoader;
  logger: Logger;
  registry: AdapterRegistry;
  tokenManager: TokenManager;
  alerts: AlertDispatcher;
  /** Redis URL enables BullMQ enqueueing; when absent jobs run inline. */
  redisUrl?: string;
}

/** Cron expressions, overridable via env for ops/testing. */
function cronExprs(secrets: SecretLoader): Record<string, string> {
  return {
    tokenRefresh: secrets.optional('CRON_TOKEN_REFRESH') ?? '0 */12 * * *', // every 12h
    analyticsCollect: secrets.optional('CRON_ANALYTICS_COLLECT') ?? '0 */6 * * *', // every 6h
    publishDueScan: secrets.optional('CRON_PUBLISH_SCAN') ?? '* * * * *', // every minute
    weeklyFeedback: secrets.optional('CRON_WEEKLY_FEEDBACK') ?? '0 0 * * 0', // Sun 00:00
    retentionPurge: secrets.optional('CRON_RETENTION_PURGE') ?? '30 3 * * *', // daily 03:30
  };
}

// --- AI marketing autopilot (opt-in) ----------------------------------------

/** Default cron expressions for the opt-in autopilot jobs (env-overridable). */
export const AUTOPILOT_CRON_DEFAULTS = {
  autoResearch: '0 2 * * 1', // Mon 02:00
  autoPlan: '0 3 * * 1', // Mon 03:00
  assetRetry: '*/15 * * * *', // every 15 minutes
} as const;

/** Fallback markets when AUTOPILOT_MARKETS is empty/unset/all-invalid. */
export const DEFAULT_AUTOPILOT_MARKETS: readonly Market[] = ['JAPAN', 'KOREA', 'GERMANY', 'TAIWAN'];

/** Default oldest-first batch size for the asset-render-retry job. */
export const DEFAULT_ASSET_RETRY_BATCH = 5;

/** Asset statuses the retry job re-renders (the not-yet-rendered set). */
const RETRYABLE_ASSET_STATUSES: ReadonlySet<string> = new Set(['SPEC_READY', 'FAILED']);

/**
 * PURE: truthy check for an enable flag. Accepts 'true' / '1' / 'yes' (any case,
 * surrounding whitespace tolerated); everything else (incl. undefined) is false.
 */
export function isJobEnabled(flag: string | undefined): boolean {
  if (typeof flag !== 'string') return false;
  const v = flag.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * PURE: parse/validate the AUTOPILOT_MARKETS comma list into canonical Markets.
 * Upper-cases + trims each entry, drops blanks and unknown markets, de-dupes
 * (first occurrence wins). Falls back to DEFAULT_AUTOPILOT_MARKETS when the
 * input is empty/unset or contains no valid market.
 */
export function parseMarketsEnv(value: string | undefined): Market[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [...DEFAULT_AUTOPILOT_MARKETS];
  }
  const seen = new Set<Market>();
  for (const raw of value.split(',')) {
    const code = raw.trim().toUpperCase();
    if (isMarket(code) && !seen.has(code)) {
      seen.add(code);
    }
  }
  return seen.size > 0 ? [...seen] : [...DEFAULT_AUTOPILOT_MARKETS];
}

/**
 * PURE: parse the optional AUTOPILOT_CHANNELS comma list into a trimmed,
 * non-empty, de-duplicated string list. Returns undefined when empty/unset so
 * the planner falls back to its full default channel/format matrix.
 */
export function parseChannelsEnv(value: string | undefined): string[] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const seen = new Set<string>();
  for (const raw of value.split(',')) {
    const c = raw.trim().toLowerCase();
    if (c.length > 0) seen.add(c);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * PURE: parse the ASSET_RETRY_BATCH env into a positive integer batch size,
 * falling back to DEFAULT_ASSET_RETRY_BATCH for missing/invalid/<=0 values.
 */
export function parseAssetRetryBatch(value: string | undefined): number {
  if (typeof value !== 'string' || value.trim().length === 0) return DEFAULT_ASSET_RETRY_BATCH;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return DEFAULT_ASSET_RETRY_BATCH;
  return n;
}

/** Minimal asset shape the pure retry-selection helper needs. */
export interface RetryableAsset {
  id: string;
  status: string;
  updatedAt: Date;
}

/**
 * PURE: select the assets to re-render this tick. Keeps only SPEC_READY/FAILED
 * (never RENDERED/RENDERING), orders oldest-first by updatedAt (stable id
 * tie-break for determinism), and caps at `batch`. Non-positive batch yields [].
 */
export function selectAssetsToRetry<T extends RetryableAsset>(assets: readonly T[], batch: number): T[] {
  if (!Number.isFinite(batch) || batch <= 0) return [];
  return assets
    .filter((a) => RETRYABLE_ASSET_STATUSES.has(a.status))
    .slice()
    .sort((a, b) => {
      const at = a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0;
      const bt = b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    })
    .slice(0, Math.floor(batch));
}

/** A scheduled job spec the optional autopilot jobs are described by. */
export interface OptionalJobSpec {
  name: string;
  cron: string;
}

/**
 * PURE (env-only): the list of opt-in autopilot jobs that should be REGISTERED
 * given the current secrets/env — i.e. those whose enable flag is truthy. Each
 * carries its (env-overridable) cron. Used both to register the jobs and to log
 * which optional jobs are enabled at startup. node-cron is never touched here.
 */
export function optionalJobsToRegister(secrets: SecretLoader): OptionalJobSpec[] {
  const jobs: OptionalJobSpec[] = [];
  if (isJobEnabled(secrets.optional('AUTOPILOT_AUTO_RESEARCH'))) {
    jobs.push({
      name: 'auto-market-research',
      cron: secrets.optional('CRON_AUTO_RESEARCH') ?? AUTOPILOT_CRON_DEFAULTS.autoResearch,
    });
  }
  if (isJobEnabled(secrets.optional('AUTOPILOT_AUTO_PLAN'))) {
    jobs.push({
      name: 'auto-content-plan',
      cron: secrets.optional('CRON_AUTO_PLAN') ?? AUTOPILOT_CRON_DEFAULTS.autoPlan,
    });
  }
  if (isJobEnabled(secrets.optional('AUTOPILOT_ASSET_RETRY'))) {
    jobs.push({
      name: 'asset-render-retry',
      cron: secrets.optional('CRON_ASSET_RETRY') ?? AUTOPILOT_CRON_DEFAULTS.assetRetry,
    });
  }
  return jobs;
}

/**
 * Build, register, and start every scheduled job. Returns the scheduler so the
 * process can stop it on graceful shutdown.
 */
export function startScheduledJobs(deps: JobDeps): Scheduler {
  const { prisma, secrets, logger, registry, tokenManager, alerts, redisUrl } = deps;
  const scheduler = new NodeCronScheduler(logger);
  const exprs = cronExprs(secrets);

  // Shared domain event bus (same singleton composeServices uses) so the
  // scheduled publish/feedback paths emit real-time events too.
  const eventBus = getEventBus(redisUrl);

  // When Redis is configured, the cron jobs only ENQUEUE work onto BullMQ
  // (which owns retry/backoff and concurrency); the queue workers do the work.
  // Without Redis the cron runs the work inline as a fallback.
  const publishQueue = redisUrl ? createPublishQueue(redisUrl) : undefined;
  const scoreQueue = redisUrl ? createScoreQueue(redisUrl) : undefined;

  // --- Token refresh cycle (every 12h) --------------------------------------
  scheduler.schedule('token-refresh', exprs.tokenRefresh, async () => {
    await tokenManager.runRefreshCycle();
  });

  // --- Analytics collection cycle (every 6h) + event-driven scoring ---------
  const collection = new CollectionService(prisma, registry, tokenManager, alerts);
  const scoringInline = new ScoringService(prisma);
  scheduler.schedule('analytics-collect', exprs.analyticsCollect, async () => {
    const report = await collection.runCycle();
    for (const outcome of report.outcomes) {
      if (!outcome.ok) continue;
      if (scoreQueue) {
        await enqueueScore(scoreQueue, outcome.postId);
      } else {
        try {
          await scoringInline.scoreByPost(outcome.postId);
        } catch (err) {
          logger.error(
            { job: 'analytics-collect', postId: outcome.postId, error: (err as Error).message },
            'inline scoring after collection failed for a post',
          );
        }
      }
    }
  });

  // --- Publishing due-scan (every minute) -----------------------------------
  const inlineWorker = new PublishingWorker(prisma, registry, tokenManager, alerts, undefined, eventBus);
  scheduler.schedule('publish-due-scan', exprs.publishDueScan, async () => {
    const due = await inlineWorker.scanDue();
    for (const post of due) {
      if (publishQueue) {
        // Enqueue; the BullMQ publish worker locks + publishes with backoff.
        await enqueuePublish(publishQueue, post.id);
      } else {
        const locked = await inlineWorker.tryLock(post.id);
        if (locked) await inlineWorker.publish(post.id);
      }
    }
  });

  // --- Weekly feedback analysis (Sun 00:00) ---------------------------------
  // Build the AI text client from the SAME normalized config path as
  // composeServices (Config_Parser owns the default model `deepseek-v4-flash`
  // and base-url/model validation); fail-fast on invalid config, naming ONLY the
  // offending key — never a secret value. One instance is shared by the
  // FeedbackEngine and the ReportService below.
  const aiTextClient = buildAiTextClient(secrets);
  const feedback = new FeedbackEngine(prisma, aiTextClient, undefined, alerts, undefined, eventBus);
  scheduler.schedule('weekly-feedback', exprs.weeklyFeedback, async () => {
    await feedback.run();
  });

  // --- Retention purge (daily; OPT-IN, destructive) -------------------------
  // ENFORCES the retention schedule: hard-deletes aged analytics, anonymizes
  // aged lead/intake PII, and redacts stale audit/activity log detail payloads.
  // Because it DELETES/anonymizes real data, the destructive run is gated behind
  // RETENTION_PURGE_ENABLED (default OFF) so it never surprise-purges on a fresh
  // deploy. The job is still REGISTERED (visible/observable) and logs a skip line
  // until an operator opts in after reviewing the windows. Errors are caught +
  // logged by the NodeCronScheduler.
  const retentionEnabled = isJobEnabled(secrets.optional('RETENTION_PURGE_ENABLED'));
  const retentionPurge = new RetentionPurgeService(prisma, {
    analyticsMonths: parseRetentionMonths(
      secrets.optional('RETENTION_ANALYTICS_MONTHS'),
      DEFAULT_RETENTION_CONFIG.analyticsMonths,
    ),
    piiMonths: parseRetentionMonths(
      secrets.optional('RETENTION_PII_MONTHS'),
      DEFAULT_RETENTION_CONFIG.piiMonths,
    ),
    logMonths: parseRetentionMonths(
      secrets.optional('RETENTION_LOG_MONTHS'),
      DEFAULT_RETENTION_CONFIG.logMonths,
    ),
  });
  scheduler.schedule('retention-purge', exprs.retentionPurge, async () => {
    if (!retentionEnabled) {
      logger.info(
        { job: 'retention-purge' },
        'retention-purge skipped: RETENTION_PURGE_ENABLED is not set (no data was purged)',
      );
      return;
    }
    const summary = await retentionPurge.purge(new Date());
    logger.info({ job: 'retention-purge', ...summary }, 'retention purge completed a run');
  });

  // --- AI marketing autopilot (OPT-IN; OFF by default) ----------------------
  // Each optional job is REGISTERED only when its enable flag is truthy, so it
  // never surprise-runs or burns AI quota. The set is computed purely from env.
  const optionalJobs = optionalJobsToRegister(secrets);
  const enabledOptionalJobs = optionalJobs.map((j) => j.name);
  registerAutopilotJobs(scheduler, optionalJobs, deps);

  // --- Company AI reports (weekly + monthly) --------------------------------
  // Reuse the AI text client already built for weekly-feedback so the report
  // interpretation seam shares the same configured key/model. ReportService
  // falls back to a deterministic summary when the AI client is absent/fails, and
  // the jobs only ever persist DRAFT reports (review mode). Errors thrown inside
  // these jobs are caught + logged by the NodeCronScheduler (Req 4.1, 4.3).
  const reportService = new ReportService(prisma, aiTextClient);
  registerReportJobs(scheduler, { reportService, secrets });

  // --- Study-abroad timeline sweep (every 30m by default) -------------------
  // Proactively creates idempotent due-item reminders for application/visa
  // timelines (study-abroad-ai-advisor-suite Req 15.1, 21.4). Reminder creation
  // is idempotent via ReminderLog @@unique(dueItemId, windowKey); failures are
  // caught + logged by the NodeCronScheduler (per job name + timestamp).
  const timelineAgent = new TimelineAgent(prisma, new NotificationService(prisma, eventBus));
  const timelineSweepCron = secrets.optional('CRON_TIMELINE_SWEEP') ?? '*/30 * * * *';
  scheduler.schedule('study-timeline-sweep', timelineSweepCron, async () => {
    await timelineAgent.sweepDueReminders(new Date());
  });

  scheduler.start();
  logger.info(
    {
      jobs: [
        ...Object.keys(exprs),
        'weekly-company-report',
        'monthly-company-report',
        'study-timeline-sweep',
      ],
      optionalJobs: enabledOptionalJobs,
      queueMode: Boolean(redisUrl),
    },
    'Scheduled jobs started',
  );
  return scheduler;
}

/**
 * Register the enabled opt-in autopilot jobs on the scheduler. Only the jobs in
 * `optionalJobs` (already filtered to enabled-by-env) are wired, each at its
 * resolved cron. Errors thrown inside a job are caught + logged by the scheduler.
 */
function registerAutopilotJobs(
  scheduler: Scheduler,
  optionalJobs: OptionalJobSpec[],
  deps: JobDeps,
): void {
  const byName = new Map(optionalJobs.map((j) => [j.name, j.cron] as const));

  const researchCron = byName.get('auto-market-research');
  if (researchCron) {
    scheduler.schedule('auto-market-research', researchCron, () => runAutoResearch(deps));
  }

  const planCron = byName.get('auto-content-plan');
  if (planCron) {
    scheduler.schedule('auto-content-plan', planCron, () => runAutoContentPlan(deps));
  }

  const retryCron = byName.get('asset-render-retry');
  if (retryCron) {
    scheduler.schedule('asset-render-retry', retryCron, () => runAssetRenderRetry(deps));
  }
}

/**
 * Build an AI text client from the SAME normalized config path as
 * composeServices: the pure Config_Parser reads the non-secret connection keys
 * (GEMINI_BASE_URL / GEMINI_MODEL / GEMINI_TIMEOUT_MS), applies the default model
 * (`deepseek-v4-flash`) and timeout normalization, and validates base-url/model.
 * Invalid config fails fast, naming ONLY the offending key — never a secret
 * value (R8.4). The API key is read separately and handed to the client directly;
 * its value is never logged.
 */
function buildAiTextClient(secrets: SecretLoader): AiTextClient {
  const parsed = parseAiTextConfigFromSecrets(secrets);
  if (!parsed.ok) {
    throw new Error(`AI text config invalid: key "${parsed.invalidKey}" ${parsed.message}`);
  }
  return new AiTextClient(
    secrets.optional('GEMINI_API_KEY'),
    parsed.config,
    undefined,
    parseMaxTokensEnv(secrets.optional('GEMINI_MAX_TOKENS')),
  );
}

/**
 * Build an inline AI text client for the opt-in autopilot jobs (research +
 * planning). Delegates to {@link buildAiTextClient} so the model id is never
 * hardcoded — the Config_Parser owns the default (`deepseek-v4-flash`). The
 * function name is kept stable so existing callers do not break.
 */
function buildInlineGemini(secrets: SecretLoader): AiTextClient {
  return buildAiTextClient(secrets);
}

/** Brand-knowledge grounding provider, built inline from prisma (like the routes do). */
function buildBrandKnowledge(prisma: PrismaClient): KnowledgeBrandProvider {
  return new KnowledgeBrandProvider(new KnowledgeService(prisma));
}

/**
 * auto-market-research: refresh trend signals for each configured market. Each
 * market is isolated in its own try/catch so one failure never stops the rest;
 * per-market counts are logged. Grounded with the inline AI text client + brand knowledge.
 */
async function runAutoResearch(deps: JobDeps): Promise<void> {
  const { prisma, secrets, logger } = deps;
  const markets = parseMarketsEnv(secrets.optional('AUTOPILOT_MARKETS'));
  const gemini = buildInlineGemini(secrets);
  const brandKnowledge = buildBrandKnowledge(prisma);
  const research = new TrendResearchService(prisma, gemini, brandKnowledge);

  for (const market of markets) {
    try {
      const result = await research.research(market);
      logger.info(
        { job: 'auto-market-research', market, created: result.created.length, aiGenerated: result.aiGenerated },
        'auto-market-research refreshed trend signals for a market',
      );
    } catch (err) {
      logger.error(
        { job: 'auto-market-research', market, error: (err as Error).message },
        'auto-market-research failed for a market (others continue)',
      );
    }
  }
}

/**
 * auto-content-plan: generate a DRAFT content plan per configured market for the
 * next 7 days. REVIEW-MODE SAFE — this creates DRAFT plans ONLY: a human still
 * reviews/activates the plan and triggers generation/publishing. It does NOT
 * auto-generate drafts or auto-publish (respects "performance not volume").
 * Each market is isolated in its own try/catch; plan id + item counts are logged.
 */
async function runAutoContentPlan(deps: JobDeps): Promise<void> {
  const { prisma, secrets, logger } = deps;
  const markets = parseMarketsEnv(secrets.optional('AUTOPILOT_MARKETS'));
  const channels = parseChannelsEnv(secrets.optional('AUTOPILOT_CHANNELS'));
  const gemini = buildInlineGemini(secrets);
  const brandKnowledge = buildBrandKnowledge(prisma);
  const planner = new ContentPlanner(prisma, gemini, brandKnowledge);

  const now = new Date();
  const periodTo = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // now + 7 days

  for (const market of markets) {
    try {
      const plan = await planner.generatePlan({
        market,
        objective: 'Lead',
        periodFrom: now,
        periodTo,
        channels,
      });
      logger.info(
        { job: 'auto-content-plan', market, planId: plan.id, status: plan.status, items: plan.items.length },
        'auto-content-plan created a DRAFT plan for a market (awaiting human review)',
      );
    } catch (err) {
      logger.error(
        { job: 'auto-content-plan', market, error: (err as Error).message },
        'auto-content-plan failed for a market (others continue)',
      );
    }
  }
}

/**
 * asset-render-retry: re-render not-yet-rendered assets (SPEC_READY/FAILED) once
 * a media render provider is configured. Picks the oldest `batch` candidates and
 * re-renders each via the provider using the persisted spec, transitioning to
 * RENDERED or FAILED. Each asset is isolated in its own try/catch.
 *
 * No-op (with a log) when no media provider is configured. There is no attempt
 * cap: a FAILED asset simply stays FAILED and is retried again next tick — the
 * 15-minute cadence auto-picks-up images when provider capacity frees (e.g. when
 * a 429-throttled gateway recovers). This is acceptable and intentional.
 */
async function runAssetRenderRetry(deps: JobDeps): Promise<void> {
  const { prisma, secrets, logger } = deps;
  const provider = createMediaRenderProvider(secrets);
  if (!provider) {
    logger.info(
      { job: 'asset-render-retry' },
      'asset-render-retry skipped: no media render provider configured',
    );
    return;
  }

  const batch = parseAssetRetryBatch(secrets.optional('ASSET_RETRY_BATCH'));
  // Oldest-first candidates limited to the batch (DB-side); the pure selector
  // re-asserts the status/order/cap invariant defensively.
  const candidates = await prisma.generatedAsset.findMany({
    where: { status: { in: ['SPEC_READY', 'FAILED'] } },
    orderBy: { updatedAt: 'asc' },
    take: batch,
  });
  const toRetry = selectAssetsToRetry(candidates, batch);

  const generator = new AssetGenerator(prisma, provider);
  let rendered = 0;
  let failed = 0;
  for (const asset of toRetry) {
    try {
      const kind = isAssetKind(asset.kind) ? asset.kind : 'image';
      const spec = specFromAsset(kind, asset.spec);
      const out = await provider.render(spec);
      await generator.markRendered(asset.id, out.storageKey, out.mimeType, provider.name);
      rendered += 1;
    } catch {
      // Provider failed for this asset — record FAILED, never fabricate bytes.
      try {
        await generator.markFailed(asset.id);
      } catch (markErr) {
        logger.error(
          { job: 'asset-render-retry', assetId: asset.id, error: (markErr as Error).message },
          'asset-render-retry could not mark an asset FAILED',
        );
      }
      failed += 1;
    }
  }
  logger.info(
    { job: 'asset-render-retry', candidates: toRetry.length, rendered, failed, batch },
    'asset-render-retry completed a tick',
  );
}
