/**
 * CustomCmsAdapter — owned Custom CMS REST API integration (Req 9.2).
 *
 * Publishes via `/cms/posts` and reads metrics via `/cms/posts/{id}/analytics`.
 * The CMS base URL is non-secret config injected at construction (the server
 * host itself lives in the Secret_Store and is never hardcoded). Missing/
 * placeholder token -> 502 "platform not configured".
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
import { createFetchHttpClient } from './httpClient';
import type { HttpClient, HttpResponse } from './httpClient';
import { requireToken } from './tokenProvider';
import type { PlatformTokenProvider } from './tokenProvider';
import { asNumberOrNull, asString, readPath } from './narrow';
import { AppError } from '../infra/errors';

export interface CustomCmsAdapterDeps {
  tokens: PlatformTokenProvider;
  httpClient?: HttpClient;
  /**
   * Fully-qualified CMS API base URL (e.g. https://{domain}/api/v1). Supplied
   * from config/secret store — never hardcoded. Required to operate.
   */
  baseUrl?: string;
}

function ensureOk(platform: PlatformId, res: HttpResponse): void {
  if (!res.ok) {
    throw new AppError(502, `Platform "${platform}" request failed`, 'PLATFORM_REQUEST_FAILED');
  }
}

export class CustomCmsAdapter extends BasePlatformAdapter {
  readonly platform: PlatformId = 'custom_cms';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['publish', 'analytics']);

  private readonly tokens: PlatformTokenProvider;
  private readonly http: HttpClient;
  private readonly baseUrl: string | undefined;

  constructor(deps: CustomCmsAdapterDeps) {
    super();
    this.tokens = deps.tokens;
    this.http = deps.httpClient ?? createFetchHttpClient();
    this.baseUrl = deps.baseUrl;
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl || this.baseUrl.trim().length === 0) {
      throw new AppError(502, `Platform "${this.platform}" is not configured`, 'PLATFORM_NOT_CONFIGURED');
    }
    return this.baseUrl;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    this.assertSupported('publish');
    const base = this.requireBaseUrl();
    const token = requireToken(this.tokens, this.platform);

    const res = await this.http.post(
      `${base}/cms/posts`,
      {
        title: req.title,
        body: [req.body, ...req.ctas].filter((s) => s.length > 0).join('\n\n'),
        featured_image: req.mediaUrls?.[0],
        status: 'publish',
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
      url: asString(readPath(res.body, 'post_url')),
      raw: res.body,
    };
  }

  async collectAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult> {
    this.assertSupported('analytics');
    const base = this.requireBaseUrl();
    const token = requireToken(this.tokens, this.platform);
    if (!query.externalPostId) {
      throw new AppError(502, `Platform "${this.platform}" analytics require a post id`, 'PLATFORM_BAD_REQUEST');
    }

    const res = await this.http.get(`${base}/cms/posts/${query.externalPostId}/analytics`, {
      headers: { authorization: `Bearer ${token}` },
      query: { from: query.from, to: query.to },
    });
    ensureOk(this.platform, res);

    return {
      metrics: {
        views: asNumberOrNull(readPath(res.body, 'views')),
        sessions: asNumberOrNull(readPath(res.body, 'sessions')),
        conversions: asNumberOrNull(readPath(res.body, 'conversions')),
      },
      raw: res.body,
    };
  }
}
