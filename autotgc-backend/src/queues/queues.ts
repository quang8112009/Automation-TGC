/**
 * BullMQ queue factories and enqueue helpers (Publishing + Scoring async design).
 *
 * These are the producer-side primitives: queue construction with the shared
 * retry/backoff/cleanup policy, plus idempotent enqueue helpers that pin a
 * deterministic `jobId` so the same post (or score request) is never
 * double-queued. Nothing here opens a Redis connection at import time — a
 * connection is only created when a factory function is called, because
 * `getRedis` is lazy.
 */
import { Queue } from 'bullmq';
import type { ConnectionOptions, Job, JobsOptions, QueueOptions } from 'bullmq';
import { getRedis } from '../infra/redis';

/**
 * BullMQ bundles its own nested copy of ioredis, so the `Redis` instance from
 * our `getRedis` is structurally identical but nominally distinct from the type
 * BullMQ's `ConnectionOptions` expects (protected members break structural
 * assignment). This single seam reuses the shared connection while satisfying
 * BullMQ's type — it does not open a new connection.
 */
function connectionFor(redisUrl: string): ConnectionOptions {
  return getRedis(redisUrl) as unknown as ConnectionOptions;
}

/** Stable queue names shared by producers (this module) and consumers (workers.ts). */
export const QUEUE_NAMES = {
  publish: 'publish-queue',
  score: 'score-queue',
} as const;

/** Job payload for the publish queue. */
export interface PublishJobData {
  scheduledPostId: string;
}

/** Job payload for the score queue. */
export interface ScoreJobData {
  postId: string;
}

/**
 * Default job options applied to every job added to either queue:
 * 4 attempts with exponential backoff (base 2s), and bounded retention of
 * completed/failed jobs so Redis does not grow unbounded.
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

/**
 * Every queue this module creates, tracked so {@link closeQueues} can release
 * them. The connections themselves are owned by the shared `getRedis` client.
 */
const createdQueues: Queue[] = [];

function buildQueueOptions(redisUrl: string): QueueOptions {
  return {
    connection: connectionFor(redisUrl),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  };
}

/** Create the publish queue bound to the shared Redis connection. */
export function createPublishQueue(redisUrl: string): Queue<PublishJobData> {
  const queue = new Queue<PublishJobData>(QUEUE_NAMES.publish, buildQueueOptions(redisUrl));
  createdQueues.push(queue);
  return queue;
}

/** Create the score queue bound to the shared Redis connection. */
export function createScoreQueue(redisUrl: string): Queue<ScoreJobData> {
  const queue = new Queue<ScoreJobData>(QUEUE_NAMES.score, buildQueueOptions(redisUrl));
  createdQueues.push(queue);
  return queue;
}

/**
 * Enqueue a publish job. The `jobId` is pinned to the scheduled post id so a
 * post that is already queued (waiting/delayed/active) is not double-queued:
 * BullMQ ignores an add whose jobId already exists.
 */
export async function enqueuePublish(
  queue: Queue<PublishJobData>,
  scheduledPostId: string,
): Promise<Job<PublishJobData>> {
  return queue.add('publish', { scheduledPostId }, { jobId: scheduledPostId });
}

/**
 * Enqueue a scoring job for a published post. The `jobId` is namespaced
 * (`score:<postId>`) so a pending score request for the same post is deduped.
 */
export async function enqueueScore(
  queue: Queue<ScoreJobData>,
  postId: string,
): Promise<Job<ScoreJobData>> {
  return queue.add('score', { postId }, { jobId: `score:${postId}` });
}

/** Close every queue created by this module (idempotent). */
export async function closeQueues(): Promise<void> {
  const queues = createdQueues.splice(0, createdQueues.length);
  await Promise.all(queues.map((q) => q.close()));
}
