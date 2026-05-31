/**
 * Shared service composition — builds the platform/token/alert/AI/media services
 * once so both the HTTP layer (app.ts) and the scheduled jobs (jobs.ts) use the
 * same instances. Keeps wiring in one place.
 */
import type { PrismaClient } from '@prisma/client';
import type { SecretLoader } from './secrets';
import { AdapterRegistry } from '../platforms/registry';
import { FacebookAdapter } from '../platforms/facebookAdapter';
import { TikTokAdapter } from '../platforms/tiktokAdapter';
import { CustomCmsAdapter } from '../platforms/customCmsAdapter';
import { Ga4Adapter } from '../platforms/ga4Adapter';
import { YouTubeAdapter } from '../platforms/youtubeAdapter';
import { ZaloAdapter } from '../platforms/zaloAdapter';
import { TokenManager } from '../tokens/tokenManager';
import type { TokenRefresher } from '../tokens/tokenManager';
import { PrismaAlertDispatcher } from './alerts';
import type { AlertDispatcher } from './alerts';
import { GeminiClient } from './gemini';
import { MediaService } from '../content/mediaService';
import { getEventBus } from './events';
import type { EventBus } from './events';
import { createMediaRenderProvider } from '../marketing/assets/providers/mediaRenderProvider';
import type { RenderProvider } from '../marketing/assets/assetGenerator';

export interface ComposedServices {
  registry: AdapterRegistry;
  tokenManager: TokenManager;
  alerts: AlertDispatcher;
  gemini: GeminiClient;
  mediaService: MediaService;
  /** Shared domain event bus (Redis-backed when a URL is configured). */
  eventBus: EventBus;
  /**
   * Image+video render provider for brand assets. `undefined` when NEITHER the
   * image nor the video modality is configured (assets then stay SPEC_READY).
   */
  mediaRenderProvider?: RenderProvider;
}

/** Default no-op refresher: real per-platform token exchange requires live creds. */
const noopRefresher: TokenRefresher = {
  async exchange(): Promise<void> {
    // No external exchange in Phase 1 without credentials; refresh bumps metadata only.
  },
};

export function composeServices(prisma: PrismaClient, secrets: SecretLoader): ComposedServices {
  // Shared domain event bus. REDIS_URL is the same source config.redisUrl uses;
  // when absent the bus degrades to an in-process emitter (single-process mode).
  const eventBus = getEventBus(secrets.optional('REDIS_URL') ?? undefined);

  const alerts = new PrismaAlertDispatcher(prisma);
  const tokenManager = new TokenManager(prisma, secrets, noopRefresher, alerts, undefined, eventBus);

  const registry = new AdapterRegistry();
  registry.register(new FacebookAdapter({ tokens: tokenManager }));
  registry.register(new TikTokAdapter({ tokens: tokenManager }));
  registry.register(
    new CustomCmsAdapter({ tokens: tokenManager, baseUrl: secrets.optional('CMS_BASE_URL') }),
  );
  registry.register(
    new Ga4Adapter({ tokens: tokenManager, propertyId: secrets.optional('GA4_PROPERTY_ID') }),
  );
  // AI marketing autopilot channels (Phase 2 brought forward): YouTube + Zalo OA.
  registry.register(
    new YouTubeAdapter({
      tokens: tokenManager,
      privacyStatus: secrets.optional('YOUTUBE_PRIVACY_STATUS'),
    }),
  );
  registry.register(new ZaloAdapter({ tokens: tokenManager }));

  // Text model + host are configurable (GEMINI_MODEL / GEMINI_BASE_URL). The
  // system now targets the OpenAI-COMPATIBLE YeScale gateway, so GEMINI_BASE_URL
  // MUST be the gateway's `/v1` base (the deploy step sets it); the client then
  // calls `${base}/chat/completions` with Bearer auth. The key comes from the
  // Secret_Store. When GEMINI_BASE_URL is unset the client falls back to the
  // PLATFORM_BASE_URLS.gemini default (only useful for a Google-shaped host).
  const geminiBaseUrl = secrets.optional('GEMINI_BASE_URL');
  const gemini = new GeminiClient(
    secrets.optional('GEMINI_API_KEY'),
    secrets.optional('GEMINI_MODEL') ?? 'gemini-2.5-flash',
    undefined,
    geminiBaseUrl && geminiBaseUrl.trim().length > 0 ? geminiBaseUrl : undefined,
  );
  const mediaService = new MediaService(prisma, secrets.optional('MEDIA_DIR'));

  // Image + video render provider for brand assets. Reads its own env
  // (GEMINI_IMAGE_* / VEO_* / ASSET_RENDER_DIR) and returns `undefined` when
  // NEITHER modality is configured, so AssetGenerator stays in blueprint
  // (SPEC_READY) mode. All keys/models/base-urls are env-driven (proxy-ready);
  // nothing is hardcoded. Providers degrade to a clean 502 when unconfigured.
  const mediaRenderProvider = createMediaRenderProvider(secrets);

  return { registry, tokenManager, alerts, gemini, mediaService, eventBus, mediaRenderProvider };
}
