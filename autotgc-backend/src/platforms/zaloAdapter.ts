/**
 * ZaloAdapter — Zalo Official Account (OA) Open API integration (extends the
 * Phase-1 platform-adapter pattern; Req 9.2, 9.5).
 *
 * ENDPOINT SHAPES (public hosts only; no secrets/hosts hardcoded — the base URL
 * lives in PLATFORM_BASE_URLS and the OA access_token is injected via the
 * Token_Manager / Secret_Store through the PlatformTokenProvider seam):
 *   - publish: POST `${base}/article/create` (Zalo OA "create article").
 *              The OA access_token is sent in the `access_token` header (Zalo's
 *              convention) and the content is built from { title, body, ctas }.
 *              Response shape { data: { id } } (Zalo wraps payloads in `data`,
 *              with `id` as the created article id) -> PublishResult.externalId.
 *              CHOICE: we use the article-create shape rather than
 *              `/oa/message` (broadcast) because publishing a content draft maps
 *              naturally onto creating an OA article/post rather than pushing a
 *              direct message to a user thread.
 *              Without live OA credentials this returns a clean 502 ("platform
 *              not configured") before any HTTP call — mirroring how
 *              FacebookAdapter/TikTokAdapter behave without creds.
 *   - analytics: NOT AVAILABLE in Phase 1. collectAnalytics() calls
 *              assertSupported('analytics'), which throws
 *              UnsupportedOperationError (-> 400), exactly like the GA4 adapter
 *              throws for an unsupported publish.
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
import { createFetchHttpClient } from './httpClient';
import type { HttpClient, HttpResponse } from './httpClient';
import { requireToken } from './tokenProvider';
import type { PlatformTokenProvider } from './tokenProvider';
import { asString, readPath } from './narrow';
import { AppError } from '../infra/errors';

export interface ZaloAdapterDeps {
  tokens: PlatformTokenProvider;
  httpClient?: HttpClient;
  baseUrl?: string;
}

function ensureOk(platform: PlatformId, res: HttpResponse): void {
  if (!res.ok) {
    throw new AppError(502, `Platform "${platform}" request failed`, 'PLATFORM_REQUEST_FAILED');
  }
}

export class ZaloAdapter extends BasePlatformAdapter {
  readonly platform: PlatformId = 'zalo';
  // Publish only — Zalo OA analytics is deferred to a later phase (Req 9.5).
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['publish']);

  private readonly tokens: PlatformTokenProvider;
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  constructor(deps: ZaloAdapterDeps) {
    super();
    this.tokens = deps.tokens;
    this.http = deps.httpClient ?? createFetchHttpClient();
    this.baseUrl = deps.baseUrl ?? PLATFORM_BASE_URLS.zalo;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    this.assertSupported('publish');
    const token = requireToken(this.tokens, this.platform);

    const body = [req.body, ...req.ctas].filter((s) => s.length > 0).join('\n\n');

    const res = await this.http.post(
      `${this.baseUrl}/article/create`,
      {
        type: 'normal',
        title: req.title,
        body,
        ...(req.mediaUrls?.length ? { cover: { cover_type: 'photo', photo_url: req.mediaUrls[0] } } : {}),
      },
      { headers: { access_token: token } },
    );
    ensureOk(this.platform, res);

    const externalId =
      asString(readPath(res.body, 'data.id')) ?? asString(readPath(res.body, 'data.token'));
    if (!externalId) {
      throw new AppError(502, `Platform "${this.platform}" returned no article id`, 'PLATFORM_BAD_RESPONSE');
    }
    return {
      externalId,
      url: asString(readPath(res.body, 'data.url')),
      raw: res.body,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async collectAnalytics(_query: AnalyticsQuery): Promise<AnalyticsResult> {
    // Zalo OA analytics is not available in Phase 1 — surface a consistent 400
    // via the base helper, exactly like Ga4Adapter does for publish.
    this.assertSupported('analytics');
    // Unreachable: assertSupported throws because 'analytics' is not in the matrix.
    return { metrics: {}, raw: null };
  }
}
