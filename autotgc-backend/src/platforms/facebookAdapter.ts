/**
 * FacebookAdapter — Meta Graph API integration (Foundation Req 9.2).
 *
 * Publishes to `/{page-id}/feed` (or `/photos`,`/videos` when media is present)
 * and collects post insights from `/{post-id}/insights`. Phase 1 ships without
 * real credentials, so a missing/placeholder token yields a clear 502
 * "platform not configured" before any HTTP call is attempted.
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
import { asNumberOrNull, asString, readPath } from './narrow';
import { AppError } from '../infra/errors';

export interface FacebookAdapterDeps {
  tokens: PlatformTokenProvider;
  httpClient?: HttpClient;
  /** Page id is non-secret config; defaults to the conventional `me` alias. */
  pageId?: string;
  baseUrl?: string;
}

function ensureOk(platform: PlatformId, res: HttpResponse): void {
  if (!res.ok) {
    throw new AppError(502, `Platform "${platform}" request failed`, 'PLATFORM_REQUEST_FAILED');
  }
}

export class FacebookAdapter extends BasePlatformAdapter {
  readonly platform: PlatformId = 'facebook';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['publish', 'analytics']);

  private readonly tokens: PlatformTokenProvider;
  private readonly http: HttpClient;
  private readonly pageId: string;
  private readonly baseUrl: string;

  constructor(deps: FacebookAdapterDeps) {
    super();
    this.tokens = deps.tokens;
    this.http = deps.httpClient ?? createFetchHttpClient();
    this.pageId = deps.pageId ?? 'me';
    this.baseUrl = deps.baseUrl ?? PLATFORM_BASE_URLS.facebook;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    this.assertSupported('publish');
    const token = requireToken(this.tokens, this.platform);

    const hasMedia = (req.mediaUrls?.length ?? 0) > 0;
    const edge = hasMedia ? 'photos' : 'feed';
    const message = [req.title, req.body, ...req.ctas].filter((s) => s.length > 0).join('\n\n');

    const res = await this.http.post(
      `${this.baseUrl}/${this.pageId}/${edge}`,
      {
        message,
        ...(hasMedia ? { url: req.mediaUrls?.[0] } : {}),
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    ensureOk(this.platform, res);

    const externalId = asString(readPath(res.body, 'id')) ?? asString(readPath(res.body, 'post_id'));
    if (!externalId) {
      throw new AppError(502, `Platform "${this.platform}" returned no post id`, 'PLATFORM_BAD_RESPONSE');
    }
    return {
      externalId,
      url: asString(readPath(res.body, 'permalink_url')),
      raw: res.body,
    };
  }

  async collectAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult> {
    this.assertSupported('analytics');
    const token = requireToken(this.tokens, this.platform);
    if (!query.externalPostId) {
      throw new AppError(502, `Platform "${this.platform}" analytics require a post id`, 'PLATFORM_BAD_REQUEST');
    }

    const res = await this.http.get(`${this.baseUrl}/${query.externalPostId}/insights`, {
      headers: { authorization: `Bearer ${token}` },
      query: {
        metric: 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks',
        since: query.from,
        until: query.to,
      },
    });
    ensureOk(this.platform, res);

    return {
      metrics: {
        impressions: asNumberOrNull(readPath(res.body, 'data.0.values.0.value')),
        reach: asNumberOrNull(readPath(res.body, 'data.1.values.0.value')),
        engagedUsers: asNumberOrNull(readPath(res.body, 'data.2.values.0.value')),
        clicks: asNumberOrNull(readPath(res.body, 'data.3.values.0.value')),
      },
      raw: res.body,
    };
  }
}
