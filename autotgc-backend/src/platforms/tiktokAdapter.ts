/**
 * TikTokAdapter — TikTok Content Posting + analytics integration (Req 9.2).
 *
 * Publishes via `/post/publish/content/init/` and reads metrics via
 * `/video/query/`. Missing/placeholder token -> 502 "platform not configured".
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
import { createFetchHttpClient, PLATFORM_DEFAULT_TIMEOUT_MS } from './httpClient';
import type { HttpClient, HttpResponse } from './httpClient';
import { requireToken } from './tokenProvider';
import type { PlatformTokenProvider } from './tokenProvider';
import { asNumberOrNull, asString, readPath } from './narrow';
import { AppError } from '../infra/errors';

export interface TikTokAdapterDeps {
  tokens: PlatformTokenProvider;
  httpClient?: HttpClient;
  baseUrl?: string;
}

function ensureOk(platform: PlatformId, res: HttpResponse): void {
  if (!res.ok) {
    throw new AppError(502, `Platform "${platform}" request failed`, 'PLATFORM_REQUEST_FAILED');
  }
}

export class TikTokAdapter extends BasePlatformAdapter {
  readonly platform: PlatformId = 'tiktok';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['publish', 'analytics']);

  private readonly tokens: PlatformTokenProvider;
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  constructor(deps: TikTokAdapterDeps) {
    super();
    this.tokens = deps.tokens;
    this.http = deps.httpClient ?? createFetchHttpClient(undefined, PLATFORM_DEFAULT_TIMEOUT_MS);
    this.baseUrl = deps.baseUrl ?? PLATFORM_BASE_URLS.tiktok;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    this.assertSupported('publish');
    const token = requireToken(this.tokens, this.platform);

    // TikTok caption: title + body + CTAs (caller is responsible for the 2200-char limit).
    const caption = [req.title, req.body, ...req.ctas].filter((s) => s.length > 0).join('\n\n');

    const res = await this.http.post(
      `${this.baseUrl}/post/publish/content/init/`,
      {
        post_info: { title: req.title, description: caption },
        source_info: { source: 'PULL_FROM_URL', photo_images: req.mediaUrls ?? [] },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    ensureOk(this.platform, res);

    const externalId = asString(readPath(res.body, 'data.publish_id'));
    if (!externalId) {
      throw new AppError(502, `Platform "${this.platform}" returned no publish id`, 'PLATFORM_BAD_RESPONSE');
    }
    return { externalId, raw: res.body };
  }

  async collectAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult> {
    this.assertSupported('analytics');
    const token = requireToken(this.tokens, this.platform);
    if (!query.externalPostId) {
      throw new AppError(502, `Platform "${this.platform}" analytics require a video id`, 'PLATFORM_BAD_REQUEST');
    }

    const res = await this.http.post(
      `${this.baseUrl}/video/query/`,
      {
        filters: { video_ids: [query.externalPostId] },
        fields: ['view_count', 'like_count', 'comment_count', 'share_count'],
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    ensureOk(this.platform, res);

    const video = readPath(res.body, 'data.videos.0');
    return {
      metrics: {
        views: asNumberOrNull(readPath(video, 'view_count')),
        likes: asNumberOrNull(readPath(video, 'like_count')),
        comments: asNumberOrNull(readPath(video, 'comment_count')),
        shares: asNumberOrNull(readPath(video, 'share_count')),
      },
      raw: res.body,
    };
  }
}
