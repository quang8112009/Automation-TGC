/**
 * BullMQ consumers for the publish and score queues (Publishing + Scoring async
 * design).
 *
 * The publish worker drives the framework-free `PublishingWorker`: per job it
 * acquires the idempotency lock then publishes, translating the
 * `PublishOutcome` into BullMQ semantics — a transient retry (outcome SCHEDULED)
 * is surfaced as a thrown error so BullMQ applies the queue-level exponential
 * backoff, while PUBLISHED/FAILED are terminal and resolve the job. The score
 * worker delegates to `ScoringService.scoreByPost`.
 *
 * Like queues.ts, importing this module opens no Redis connection; a connection
 * is only established when a `start*Worker` factory is invoked (via lazy
 * `getRedis`). Worker `failed`/`error` events are handled so a processing
 * failure never crashes the host process.
 */
import { Worker } from 'bullmq';
import type { ConnectionOptions, Job, WorkerOptions } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { getRedis } from '../infra/redis';
import { getEventBus } from '../infra/events';
import { PublishingWorker } from '../content/publishingWorker';
import type { TokenChecker } from '../content/publishingWorker';
import { ScoringService } from '../analytics/scoringService';
import type { AdapterRegistry } from '../platforms/registry';
import type { AlertDispatcher } from '../infra/alerts';
import { QUEUE_NAMES } from './queues';
import type { PublishJobData, ScoreJobData } from './queues';

/** Minimal logging seam; defaults to `console` so callers need not wire one. */
export interface QueueLogger {
  error(message: string, ...meta: unknown[]): void;
}

const defaultLogger: QueueLogger = {
  error: (message: string, ...meta: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.error(message, ...meta);
  },
};

/** Dependencies for the publish worker. */
export interface PublishWorkerDeps {
  redisUrl: string;
  prisma: PrismaClient;
  registry: AdapterRegistry;
  tokenManager: TokenChecker;
  alerts: AlertDispatcher;
  logger?: QueueLogger;
}

/** Dependencies for the score worker. */
export interface ScoreWorkerDeps {
  redisUrl: string;
  prisma: PrismaClient;
  logger?: QueueLogger;
}

/** Every worker started by this module, tracked for {@link closeWorkers}. */
const startedWorkers: Worker[] = [];

/**
 * BullMQ bundles its own nested copy of ioredis, so the `Redis` instance from
 * our `getRedis` is structurally identical but nominally distinct from the type
 * BullMQ's `ConnectionOptions` expects. This seam reuses the shared connection
 * while satisfying BullMQ's type — it does not open a new connection.
 */
function connectionFor(redisUrl: string): ConnectionOptions {
  return getRedis(redisUrl) as unknown as ConnectionOptions;
}

/** Narrow untyped job data to a publish payload before use. */
function asPublishData(data: unknown): PublishJobData {
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { scheduledPostId?: unknown }).scheduledPostId === 'string'
  ) {
    return { scheduledPostId: (data as { scheduledPostId: string }).scheduledPostId };
  }
  throw new Error('Invalid publish job data: expected { scheduledPostId: string }');
}

/** Narrow untyped job data to a score payload before use. */
function asScoreData(data: unknown): ScoreJobData {
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { postId?: unknown }).postId === 'string'
  ) {
    return { postId: (data as { postId: string }).postId };
  }
  throw new Error('Invalid score job data: expected { postId: string }');
}

/** Attach non-crashing failure/error handlers shared by both workers. */
function attachSafetyHandlers(worker: Worker, queueName: string, logger: QueueLogger): void {
  worker.on('failed', (job: Job | undefined, err: Error): void => {
    logger.error(`[${queueName}] job ${job?.id ?? 'unknown'} failed: ${err.message}`, err);
  });
  worker.on('error', (err: Error): void => {
    logger.error(`[${queueName}] worker error: ${err.message}`, err);
  });
}

/**
 * Start the publish worker (concurrency 3). For each job it locks the post and,
 * if it won the lock, publishes. The outcome maps to BullMQ as follows:
 *   - PUBLISHED -> resolve (done)
 *   - FAILED    -> resolve (already alerted by the PublishingWorker)
 *   - SCHEDULED -> throw, so BullMQ retries with exponential backoff
 *   - lock not acquired / any other status -> resolve (nothing to do)
 */
export function startPublishWorker(deps: PublishWorkerDeps): Worker<PublishJobData> {
  const logger = deps.logger ?? defaultLogger;
  const opts: WorkerOptions = { connection: connectionFor(deps.redisUrl), concurrency: 3 };

  const worker = new Worker<PublishJobData>(
    QUEUE_NAMES.publish,
    async (job: Job<PublishJobData>): Promise<void> => {
      const { scheduledPostId } = asPublishData(job.data);
      const publishing = new PublishingWorker(
        deps.prisma,
        deps.registry,
        deps.tokenManager,
        deps.alerts,
        undefined,
        getEventBus(deps.redisUrl),
      );

      const locked = await publishing.tryLock(scheduledPostId);
      if (!locked) {
        // Another worker owns it, or it is no longer SCHEDULED: nothing to do.
        return;
      }

      const outcome = await publishing.publish(scheduledPostId);
      if (outcome.status === 'SCHEDULED') {
        // Transient failure was requested; throw so BullMQ backoff applies.
        throw new Error('transient, retrying');
      }
      // PUBLISHED or FAILED (and any non-actionable status) are terminal here.
    },
    opts,
  );

  attachSafetyHandlers(worker, QUEUE_NAMES.publish, logger);
  startedWorkers.push(worker);
  return worker;
}

/**
 * Start the score worker (concurrency 5). For each job it scores the published
 * post via `ScoringService.scoreByPost`. A null result (no analytics yet) is a
 * normal completion; a thrown error triggers BullMQ retry/backoff.
 */
export function startScoreWorker(deps: ScoreWorkerDeps): Worker<ScoreJobData> {
  const logger = deps.logger ?? defaultLogger;
  const opts: WorkerOptions = { connection: connectionFor(deps.redisUrl), concurrency: 5 };

  const worker = new Worker<ScoreJobData>(
    QUEUE_NAMES.score,
    async (job: Job<ScoreJobData>): Promise<void> => {
      const { postId } = asScoreData(job.data);
      const scoring = new ScoringService(deps.prisma);
      await scoring.scoreByPost(postId);
    },
    opts,
  );

  attachSafetyHandlers(worker, QUEUE_NAMES.score, logger);
  startedWorkers.push(worker);
  return worker;
}

/** Close every worker started by this module (idempotent). */
export async function closeWorkers(): Promise<void> {
  const workers = startedWorkers.splice(0, startedWorkers.length);
  await Promise.all(workers.map((w) => w.close()));
}
