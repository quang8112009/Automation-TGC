/**
 * YouTubeAdapter — YouTube Data API v3 integration (extends the Phase-1
 * platform-adapter pattern; Req 9.2, 9.5).
 *
 * ENDPOINT SHAPES (public hosts only; no secrets/hosts hardcoded — the base URL
 * lives in PLATFORM_BASE_URLS and the OAuth bearer token is injected via the
 * Token_Manager / Secret_Store through the PlatformTokenProvider seam):
 *   - publish:  POST `${base}/videos?part=snippet,status`
 *               body { snippet: { title, description }, status: { privacyStatus } }
 *               -> response { id } mapped to PublishResult.externalId and
 *                  url `https://youtu.be/{id}`.
 *               NOTE: the real videos.insert call is a multipart/resumable
 *               upload that needs the raw video bytes. Phase 1 has no binary
 *               video pipeline here, so this issues the metadata-shaped request
 *               only. Without live OAuth credentials this returns a clean 502
 *               ("platform not configured") before any HTTP call — mirroring
 *               how FacebookAdapter/TikTokAdapter behave without creds.
 *   - analytics: GET `${base}/videos?part=statistics&id={externalPostId}`
 *               -> response { items: [ { statistics: { viewCount, likeCount,
 *                  commentCount } } ] } mapped to metrics. Missing fields stay
 *                  null (never coerced to 0), per the shared null convention.
 *
 * Real publishing requires platform OAuth tokens stored in the Secret_Store /
 * TokenManager; no token => 502, identical to the other adapters.
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

export interface YouTubeAdapterDeps {
  tokens: PlatformTokenProvider;
  httpClient?: HttpClient;
  /** Upload privacy status (non-secret config); defaults to the safe `private`. */
  privacyStatus?: string;
  baseUrl?: string;
}

function ensureOk(platform: PlatformId, res: HttpResponse): void {
  if (!res.ok) {
    throw new AppError(502, `Platform "${platform}" request failed`, 'PLATFORM_REQUEST_FAILED');
  }
}

export class YouTubeAdapter extends BasePlatformAdapter {
  readonly platform: PlatformId = 'youtube';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['publish', 'analytics']);

  private readonly tokens: PlatformTokenProvider;
  private readonly http: HttpClient;
  private readonly privacyStatus: string;
  private readonly baseUrl: string;

  constructor(deps: YouTubeAdapterDeps) {
    super();
    this.tokens = deps.tokens;
    this.http = deps.httpClient ?? createFetchHttpClient(undefined, PLATFORM_DEFAULT_TIMEOUT_MS);
    this.privacyStatus = deps.privacyStatus ?? 'private';
    this.baseUrl = deps.baseUrl ?? PLATFORM_BASE_URLS.youtube;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    this.assertSupported('publish');
    const token = requireToken(this.tokens, this.platform);

    // Description: body + CTAs (title is carried separately in snippet.title).
    const description = [req.body, ...req.ctas].filter((s) => s.length > 0).join('\n\n');

    const res = await this.http.post(
      `${this.baseUrl}/videos?part=snippet,status`,
      {
        snippet: { title: req.title, description },
        status: { privacyStatus: this.privacyStatus },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    ensureOk(this.platform, res);

    const externalId = asString(readPath(res.body, 'id'));
    if (!externalId) {
      throw new AppError(502, `Platform "${this.platform}" returned no video id`, 'PLATFORM_BAD_RESPONSE');
    }
    return {
      externalId,
      url: `https://youtu.be/${externalId}`,
      raw: res.body,
    };
  }

  async collectAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult> {
    this.assertSupported('analytics');
    const token = requireToken(this.tokens, this.platform);
    if (!query.externalPostId) {
      throw new AppError(502, `Platform "${this.platform}" analytics require a video id`, 'PLATFORM_BAD_REQUEST');
    }

    const res = await this.http.get(`${this.baseUrl}/videos`, {
      headers: { authorization: `Bearer ${token}` },
      query: { part: 'statistics', id: query.externalPostId },
    });
    ensureOk(this.platform, res);

    const statistics = readPath(res.body, 'items.0.statistics');
    return {
      metrics: {
        views: asNumberOrNull(readPath(statistics, 'viewCount')),
        likes: asNumberOrNull(readPath(statistics, 'likeCount')),
        comments: asNumberOrNull(readPath(statistics, 'commentCount')),
      },
      raw: res.body,
    };
  }
}
