/**
 * Ga4Adapter — Google Analytics 4 Data API integration (Req 9.2, 9.5).
 *
 * Analytics-only: runs `/properties/{id}:runReport`. A publish request raises
 * UnsupportedOperationError (-> 400) because GA4 has no publish capability.
 * Missing/placeholder token -> 502 "platform not configured".
 */
import type {
  AnalyticsQuery,
  AnalyticsResult,
  Capability,
  PlatformId,
  PublishRequest,
  PublishResult,
} from './adapter';
import { BasePlatformAdapter } from './registry';
import { PLATFORM_BASE_URLS } from './baseUrls';
import { createFetchHttpClient } from './httpClient';
import type { HttpClient, HttpResponse } from './httpClient';
import { requireToken } from './tokenProvider';
import type { PlatformTokenProvider } from './tokenProvider';
import { asNumberOrNull, readPath } from './narrow';
import { AppError } from '../infra/errors';

export interface Ga4AdapterDeps {
  tokens: PlatformTokenProvider;
  httpClient?: HttpClient;
  /** GA4 property id (non-secret config). */
  propertyId?: string;
  baseUrl?: string;
}

function ensureOk(platform: PlatformId, res: HttpResponse): void {
  if (!res.ok) {
    throw new AppError(502, `Platform "${platform}" request failed`, 'PLATFORM_REQUEST_FAILED');
  }
}

export class Ga4Adapter extends BasePlatformAdapter {
  readonly platform: PlatformId = 'ga4';
  // Analytics only — no publish capability (Req 9.5).
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['analytics']);

  private readonly tokens: PlatformTokenProvider;
  private readonly http: HttpClient;
  private readonly propertyId: string;
  private readonly baseUrl: string;

  constructor(deps: Ga4AdapterDeps) {
    super();
    this.tokens = deps.tokens;
    this.http = deps.httpClient ?? createFetchHttpClient();
    this.propertyId = deps.propertyId ?? 'properties';
    this.baseUrl = deps.baseUrl ?? PLATFORM_BASE_URLS.ga4;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async publish(_req: PublishRequest): Promise<PublishResult> {
    // GA4 cannot publish — surface a consistent 400 via the base helper.
    return this.unsupported('publish');
  }

  async collectAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult> {
    this.assertSupported('analytics');
    const token = requireToken(this.tokens, this.platform);

    const res = await this.http.post(
      `${this.baseUrl}/properties/${this.propertyId}:runReport`,
      {
        dimensions: [{ name: 'pagePath' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'sessions' },
          { name: 'conversions' },
          { name: 'engagedSessions' },
        ],
        dateRanges: [{ startDate: query.from ?? '7daysAgo', endDate: query.to ?? 'today' }],
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    ensureOk(this.platform, res);

    const row = readPath(res.body, 'rows.0.metricValues');
    return {
      metrics: {
        screenPageViews: asNumberOrNull(readPath(row, '0.value')),
        sessions: asNumberOrNull(readPath(row, '1.value')),
        conversions: asNumberOrNull(readPath(row, '2.value')),
        engagedSessions: asNumberOrNull(readPath(row, '3.value')),
      },
      raw: res.body,
    };
  }
}
