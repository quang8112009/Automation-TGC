/**
 * Domain event bus (Infrastructure & Data Layer).
 *
 * A Redis pub/sub backed event bus so the API instance, background workers, and
 * the scheduler can publish domain events that the real-time layer (WebSocket /
 * SSE) fans out to connected clients. Falls back to an in-process emitter when
 * Redis is unavailable so the system still functions in a single process.
 *
 * Events are small JSON envelopes — never carry secrets.
 */
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { getRedis } from './redis';

/** Channels clients can subscribe to. */
export type EventTopic =
  | 'draft' // content drafts created/updated
  | 'scheduled_post' // publishing lifecycle changes
  | 'insight' // analytics insights pending/applied
  | 'lead' // new/updated leads
  | 'token_alert' // platform token expiry/refresh alerts
  | 'workflow' // agentic orchestration run progress
  | 'notification'; // generic admin notifications

export interface DomainEvent {
  topic: EventTopic;
  type: string; // e.g. 'created' | 'status_changed' | 'failed'
  payload: Record<string, unknown>;
  at: string; // ISO timestamp
}

const REDIS_CHANNEL = 'autotgc:events';

export interface EventBus {
  publish(event: Omit<DomainEvent, 'at'>): Promise<void>;
  subscribe(handler: (event: DomainEvent) => void): () => void;
  close(): Promise<void>;
}

/**
 * Redis-backed bus. Uses a dedicated subscriber connection (Redis requires a
 * connection in subscribe mode to be separate from the publisher).
 */
export class RedisEventBus implements EventBus {
  private readonly local = new EventEmitter();
  private subscriber: Redis | null = null;
  private readonly publisher: Redis;
  private started = false;

  constructor(redisUrl: string) {
    this.publisher = getRedis(redisUrl);
    this.local.setMaxListeners(0);
    // A separate connection for subscribe mode.
    this.subscriber = this.publisher.duplicate();
    void this.ensureSubscribed();
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.started || !this.subscriber) return;
    this.started = true;
    try {
      await this.subscriber.subscribe(REDIS_CHANNEL);
      this.subscriber.on('message', (_channel: string, message: string) => {
        try {
          const event = JSON.parse(message) as DomainEvent;
          this.local.emit('event', event);
        } catch {
          // ignore malformed messages
        }
      });
    } catch {
      // Redis subscribe failed; fall back to in-process emit only.
      this.subscriber = null;
    }
  }

  async publish(event: Omit<DomainEvent, 'at'>): Promise<void> {
    const full: DomainEvent = { ...event, at: new Date().toISOString() };
    const message = JSON.stringify(full);
    try {
      await this.publisher.publish(REDIS_CHANNEL, message);
    } catch {
      // Redis publish failed; deliver locally so single-process still works.
      this.local.emit('event', full);
    }
  }

  subscribe(handler: (event: DomainEvent) => void): () => void {
    const listener = (event: DomainEvent): void => handler(event);
    this.local.on('event', listener);
    return () => this.local.off('event', listener);
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(REDIS_CHANNEL);
        await this.subscriber.quit();
      } catch {
        // best effort
      }
      this.subscriber = null;
    }
  }
}

/** In-process bus for tests / no-Redis environments. */
export class InMemoryEventBus implements EventBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  async publish(event: Omit<DomainEvent, 'at'>): Promise<void> {
    this.emitter.emit('event', { ...event, at: new Date().toISOString() });
  }
  subscribe(handler: (event: DomainEvent) => void): () => void {
    const listener = (e: DomainEvent): void => handler(e);
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

let bus: EventBus | null = null;

/** Lazily build the shared event bus (Redis-backed when a URL is provided). */
export function getEventBus(redisUrl?: string): EventBus {
  if (!bus) {
    bus = redisUrl ? new RedisEventBus(redisUrl) : new InMemoryEventBus();
  }
  return bus;
}

export function setEventBus(custom: EventBus): void {
  bus = custom;
}
