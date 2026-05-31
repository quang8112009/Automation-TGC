/**
 * Platform adapter contract (Foundation Req 9.1, 9.5).
 *
 * Defines the extensible platform-adapter pattern: a uniform publish/analytics
 * surface that every external integration (Facebook, TikTok, Custom CMS, GA4)
 * implements, so other modules depend on this contract rather than on any one
 * platform's quirks. Phase 2+ platforms (Zalo OA, YouTube, Instagram) can be
 * added later by implementing this interface — no redesign required.
 */
import { ValidationError } from '../infra/errors';

/** Phase-1 platform identifiers (API_Catalog §1). Extended for the AI marketing
 * autopilot with YouTube and Zalo OA (Phase 2 channels brought forward). */
export type PlatformId = 'facebook' | 'tiktok' | 'custom_cms' | 'ga4' | 'youtube' | 'zalo';

/** Operations an adapter may expose. */
export type Capability = 'publish' | 'analytics';

/** A request to publish a content draft to a platform. */
export interface PublishRequest {
  draftId: string;
  title: string;
  body: string;
  ctas: string[];
  mediaUrls?: string[];
  /** Idempotency token: re-publishing with the same key must not double-post. */
  idempotencyKey: string;
}

/** The platform's response to a successful publish. */
export interface PublishResult {
  externalId: string;
  url?: string;
  /** Raw, unparsed platform payload retained for auditing/debugging. */
  raw: unknown;
}

/** A query for post/page analytics from a platform. */
export interface AnalyticsQuery {
  externalPostId?: string;
  from?: string;
  to?: string;
}

/** Normalized analytics result. Metric values may be null when unavailable. */
export interface AnalyticsResult {
  metrics: Record<string, number | null>;
  raw: unknown;
}

/**
 * The uniform contract every platform integration implements.
 */
export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly capabilities: ReadonlySet<Capability>;
  /** True iff this adapter implements the given capability. */
  supports(capability: Capability): boolean;
  publish(req: PublishRequest): Promise<PublishResult>;
  collectAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult>;
}

/**
 * Raised when a caller references a platform that has no registered adapter.
 * Maps to HTTP 400 (Req 9.4).
 */
export class UnsupportedPlatformError extends ValidationError {
  constructor(public readonly requestedPlatform: string) {
    super(`Unsupported platform: ${requestedPlatform}`, 'UNSUPPORTED_PLATFORM');
    this.name = 'UnsupportedPlatformError';
  }
}

/**
 * Raised when an adapter is asked to perform a capability it does not implement
 * (e.g. publishing via the analytics-only GA4 adapter). Maps to HTTP 400 (Req 9.5).
 */
export class UnsupportedOperationError extends ValidationError {
  constructor(
    public readonly platform: PlatformId,
    public readonly operation: Capability,
  ) {
    super(
      `Platform "${platform}" does not support operation "${operation}"`,
      'UNSUPPORTED_OPERATION',
    );
    this.name = 'UnsupportedOperationError';
  }
}
