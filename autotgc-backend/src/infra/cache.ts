/**
 * Cache-aside helper (Infrastructure & Data Layer).
 *
 * Thin wrapper over Redis for read-through caching of expensive reads
 * (dashboard overview, ai-context). Degrades gracefully: on any Redis error it
 * falls back to the loader so a cache outage never breaks a request.
 */
import type { Redis } from 'ioredis';
import { getRedis } from './redis';

export interface Cache {
  getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T>;
  invalidate(key: string): Promise<void>;
}

export class RedisCache implements Cache {
  private readonly redis: Redis;
  constructor(redisUrl: string) {
    this.redis = getRedis(redisUrl);
  }

  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const namespaced = `cache:${key}`;
    try {
      const cached = await this.redis.get(namespaced);
      if (cached !== null) {
        return JSON.parse(cached) as T;
      }
    } catch {
      // fall through to loader on cache read error
    }
    const value = await loader();
    try {
      await this.redis.set(namespaced, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // ignore cache write error
    }
    return value;
  }

  async invalidate(key: string): Promise<void> {
    try {
      await this.redis.del(`cache:${key}`);
    } catch {
      // ignore
    }
  }
}

/** No-op cache for tests / no-Redis environments. */
export class NoopCache implements Cache {
  async getOrSet<T>(_key: string, _ttl: number, loader: () => Promise<T>): Promise<T> {
    return loader();
  }
  async invalidate(): Promise<void> {
    /* no-op */
  }
}

export function createCache(redisUrl?: string): Cache {
  return redisUrl ? new RedisCache(redisUrl) : new NoopCache();
}
