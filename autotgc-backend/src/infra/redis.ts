/**
 * Redis client (Foundation Req 15.3). Single shared ioredis connection used for
 * the session-revocation fast path, the rate-limit store, and BullMQ queues.
 *
 * BullMQ requires `maxRetriesPerRequest: null`. The client is lazily created so
 * tests that never touch Redis don't open a connection.
 */
import IORedis from 'ioredis';
import type { Redis } from 'ioredis';

let client: Redis | null = null;

export function getRedis(url: string): Redis {
  if (!client) {
    client = new IORedis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

/** Lightweight reachability probe for the readiness endpoint. */
export async function pingRedis(url: string): Promise<boolean> {
  try {
    const res = await getRedis(url).ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}
