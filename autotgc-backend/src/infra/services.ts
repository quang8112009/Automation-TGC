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
import { AiTextClient } from './aiTextClient';
import { parseAiTextConfigFromSecrets } from './aiTextConfig';
import { InstrumentedContentGenerator, InMemoryAiTelemetrySink } from './aiTelemetry';
import { AiTextChatCompleter } from './aiChatCompleter';
import { KNOWLEDGE_SEARCH_TOOL_SCHEMA } from './knowledgeSearchTool';
import type { ChatCompleter } from './aiAgentLoop';
import type { ContentGenerator } from '../strategy/personaService';
import { MediaService } from '../content/mediaService';
import { getEventBus } from './events';
import type { EventBus } from './events';
import { createMediaRenderProvider } from '../marketing/assets/providers/mediaRenderProvider';
import type { RenderProvider } from '../marketing/assets/assetGenerator';

export interface ComposedServices {
  registry: AdapterRegistry;
  tokenManager: TokenManager;
  alerts: AlertDispatcher;
  /**
   * Shared AI text generator seam. After the DeepSeek migration this is an
   * `AiTextClient` wrapped in an `InstrumentedContentGenerator` (AgentOps
   * telemetry); consumers only depend on `generateContent`.
   */
  gemini: ContentGenerator;
  mediaService: MediaService;
  /** Shared domain event bus (Redis-backed when a URL is configured). */
  eventBus: EventBus;
  /** AgentOps telemetry sink for AI text calls (bounded in-memory window). */
  aiTelemetry: InMemoryAiTelemetrySink;
  /**
   * ChatCompleter (DeepSeek) for the agentic grounded-assistant use-case, or
   * `undefined` when AI text is not configured (assistant then runs the
   * deterministic fallback path). Offers the knowledge_search tool schema.
   */
  assistantCompleter?: ChatCompleter;
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

  // Text generation now targets an OpenAI-COMPATIBLE gateway (DeepSeek V4). The
  // non-secret connection config (GEMINI_BASE_URL / GEMINI_MODEL /
  // GEMINI_TIMEOUT_MS) is read + normalized by the pure Config_Parser, which
  // also applies the default model `deepseek-v4-flash` when GEMINI_MODEL is
  // absent (R2.2). Invalid config (e.g. missing/empty base URL or model) fails
  // the whole startup fast, naming ONLY the offending key — never a secret value
  // (R8.4). The API key is read separately and handed to the client directly.
  const parsed = parseAiTextConfigFromSecrets(secrets);
  if (!parsed.ok) {
    throw new Error(`AI text config invalid: key "${parsed.invalidKey}" ${parsed.message}`);
  }
  const rawAiTextClient = new AiTextClient(secrets.optional('GEMINI_API_KEY'), parsed.config);
  // AgentOps: wrap the client so every AI text call is timed + classified into a
  // bounded in-memory telemetry window (fallback-rate / latency / error codes),
  // without changing the seam contract or the AI-OPTIONAL fallback path.
  const aiTelemetry = new InMemoryAiTelemetrySink();
  const aiTextClient = new InstrumentedContentGenerator(rawAiTextClient, aiTelemetry, parsed.config.model);
  // Agentic grounded-assistant completer (DeepSeek) — built ONLY when a key is
  // present; offers the read-only knowledge_search tool. When unconfigured the
  // assistant route runs its deterministic fallback path.
  const assistantApiKey = secrets.optional('GEMINI_API_KEY');
  const assistantCompleter: ChatCompleter | undefined =
    assistantApiKey && assistantApiKey.trim().length > 0
      ? new AiTextChatCompleter(assistantApiKey, parsed.config, [KNOWLEDGE_SEARCH_TOOL_SCHEMA])
      : undefined;
  const mediaService = new MediaService(prisma, secrets.optional('MEDIA_DIR'));

  // Image + video render provider for brand assets. Reads its own env
  // (GEMINI_IMAGE_* / VEO_* / ASSET_RENDER_DIR) and returns `undefined` when
  // NEITHER modality is configured, so AssetGenerator stays in blueprint
  // (SPEC_READY) mode. All keys/models/base-urls are env-driven (proxy-ready);
  // nothing is hardcoded. Providers degrade to a clean 502 when unconfigured.
  const mediaRenderProvider = createMediaRenderProvider(secrets);

  return {
    registry,
    tokenManager,
    alerts,
    gemini: aiTextClient,
    mediaService,
    eventBus,
    aiTelemetry,
    assistantCompleter,
    mediaRenderProvider,
  };
}
