/**
 * buildApp — assembles a configured Fastify instance:
 * CORS, global error handler (AppError -> status, else 500), 404 handler, and
 * registration of every module's routes (foundation/leads/dashboard, platform
 * tokens, content pipeline, analytics & feedback loop).
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './infra/config';
import type { JwtService } from './auth/jwt';
import type { SecretLoader } from './infra/secrets';
import { toErrorBody, ALLOWED_STATUS_CODES } from './infra/errors';
import { registerRoutes } from './routes';
import type { ComposedServices } from './infra/services';
import { registerPlatformTokenRoutes } from './platforms/routes';
import { registerContentRoutes } from './content/routes';
import { registerAnalyticsRoutes } from './analytics/routes';
import { registerSecurity } from './http/security';
import { registerGovernance } from './governance/middleware';
import { registerGovernanceRoutes } from './governance/routes';
import { registerRequestId } from './http/requestId';
import type { RequestLogger } from './http/requestId';
import { registerReadiness } from './http/readiness';
import { registerWorkerHealth } from './http/workerHealth';
import { registerApiDocs } from './http/apiDocs';
import { registerApiInfo } from './http/apiInfo';
import { registerRealtime } from './realtime';
import { registerOrchestrationRoutes } from './orchestration/routes';
import { registerRecruitmentAgentRoutes } from './recruitment/agent/routes';
import { registerRecruitmentRoutes } from './recruitment/routes';
import { registerReportingRoutes } from './reporting/routes';
import { registerDocumentRoutes } from './recruitment/documents/routes';
import { registerOversightRoutes } from './oversight/routes';
import { registerGlobalAuthGate } from './http/authMiddleware';
import { registerMetrics } from './http/metrics';
import { statusClassOf } from './infra/metrics';
import { registerUserManagementRoutes } from './auth/userRoutes';
import { ActivityLogger } from './oversight/activityLogger';
import { AuthorizationAuditor } from './oversight/authorizationAuditor';
import { NotificationService } from './oversight/notificationService';
import { OversightService } from './oversight/oversightService';
import { registerMarketingPlanningRoutes } from './marketing/planning/routes';
import { registerMultiFormatRoutes } from './marketing/content/routes';
import { registerAssetRoutes } from './marketing/assets/routes';
import { registerAssetRenderRoutes } from './marketing/assets/renderRoutes';
import { registerAutopilotRoutes } from './marketing/autopilot/routes';
import { registerPartnerRoutes } from './partners/routes';
import { registerScholarshipRoutes } from './partners/scholarshipRoutes';
import { registerIntakeRoutes } from './intake/routes';
import { registerFollowUpRoutes } from './intake/followUpRoutes';
import { registerVisaRoutes } from './visa/routes';
import { registerPrivacyRoutes } from './privacy/routes';
import { registerAdmissionsRoutes } from './admissions/routes';
import { registerEssayRoutes } from './essays/routes';
import { registerInterviewPrepRoutes } from './interviewprep/routes';
import { registerApplicationRoutes } from './applications/routes';
import { registerRoadmapRoutes } from './roadmap/routes';
import { registerAiTelemetryRoutes } from './infra/aiTelemetryRoutes';
import { registerAssistantRoutes } from './infra/assistantRoutes';
import { MessagingChannelSender } from './intake/channelSender';
import { KnowledgeBrandProvider } from './marketing/brandKnowledge';
import { KnowledgeService } from './recruitment/knowledge/knowledgeService';
import { GenerationService, PrismaAiPromptContextReader } from './content/generationService';
import { SchedulingService } from './content/schedulingService';

export interface AppDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  redact: SecretLoader['redact'];
  services: ComposedServices;
  /** Logger for HTTP access logging (optional). */
  logger?: RequestLogger;
}

export async function buildApp(config: AppConfig, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 8_388_608, // 8 MB to accommodate base64 media uploads
    // Behind nginx (SSL termination), the client IP is in X-Forwarded-For. Trust
    // the proxy so `request.ip` is the real client — otherwise every request
    // appears to originate from the proxy and per-IP rate limiting collapses to a
    // single shared bucket (security: credential-stuffing / DoS throttling).
    trustProxy: config.trustProxy,
  });

  // Security headers + rate limiting (Redis-backed when available) — first.
  await registerSecurity(app, { rateLimitRedisUrl: config.redisUrl });

  // Governance middleware: PII detection, audit logging, workload protection.
  // Runs early in the pipeline so governance metadata is available to all
  // downstream hooks and route handlers.
  registerGovernance(app, {
    prisma: deps.prisma,
    env: process.env as Record<string, string | undefined>,
    autoPiiScan: false, // Opt-in per route (not global, for performance).
    autoAudit: true,    // Log all API requests to audit trail.
    startupScan: true,  // Scan for security issues on boot.
  });

  // Request correlation id + structured access logging.
  registerRequestId(app, deps.logger);

  // CORS. SECURITY: reflecting ANY origin (origin:true) together with
  // credentials:true is unsafe — it lets any site make credentialed cross-origin
  // requests. So credentials are enabled ONLY when a concrete allow-list origin
  // is configured; with the wildcard fallback we reflect origins but DISABLE
  // credentials. (Auth here is a Bearer header, not cookies, so disabling
  // credentialed CORS does not break the SPA.)
  const corsWildcard = config.frontendOrigin === '*';
  await app.register(cors, {
    origin: corsWildcard ? true : config.frontendOrigin,
    credentials: !corsWildcard,
  });

  // OpenAPI docs (introspects routes registered after this).
  await registerApiDocs(app);

  // Readiness probe (DB + Redis).
  registerReadiness(app, { redisUrl: config.redisUrl });

  // Worker-health probe (R4): reports worker liveness from the shared heartbeat
  // key written by the Worker_Process. Public (own status flag, no secret) and
  // returns 503 when the worker is stale/absent, like /readyz.
  registerWorkerHealth(app, { redisUrl: config.redisUrl });

  // GLOBAL AUTH GATE (deny-by-default). A single onRequest hook authenticates
  // every request that is NOT in the public allow-list (PUBLIC_PATHS: health,
  // readiness, docs, auth endpoints, HMAC webhooks, query-token realtime, the
  // public API manifest). This guarantees no route can be accidentally exposed
  // by forgetting its per-route `requireAuth`; the per-route guards remain for
  // explicit clarity and to resolve fine-grained RBAC targets, and are
  // idempotent because this hook already set `request.auth`.
  registerGlobalAuthGate(app, { prisma: deps.prisma, jwt: deps.jwt, nodeEnv: config.nodeEnv });

  // Global error handler: AppError carries its own allowed status; anything else -> 500.
  app.setErrorHandler((err, request, reply) => {
    const anyErr = err as { statusCode?: number; code?: string; name?: string };
    // Plugin-originated errors (e.g. @fastify/rate-limit -> 429, body-parse -> 400)
    // carry their own statusCode; honor any non-5xx the plugin set.
    const pluginStatus = typeof anyErr.statusCode === 'number' ? anyErr.statusCode : undefined;
    if (pluginStatus && pluginStatus >= 400 && pluginStatus < 500) {
      // Honor the plugin's 4xx, but never emit a status outside the allowed set
      // (Req 19.1). Fastify core can raise 413 (payload too large) / 415
      // (unsupported media type), which are not in our taxonomy — coerce those
      // to 400. 429 (rate-limit) is the one intentional exception and is allowed
      // through as-is.
      const allowedStatus =
        pluginStatus === 429 || ALLOWED_STATUS_CODES.has(pluginStatus)
          ? pluginStatus
          : 400;
      const code =
        allowedStatus === 429
          ? 'RATE_LIMITED'
          : typeof anyErr.code === 'string' && anyErr.code.length > 0
            ? anyErr.code
            : 'BAD_REQUEST';
      const msg = err instanceof Error ? err.message : 'Request rejected';
      reply.code(allowedStatus).send({ error: { code, message: deps.redact(msg) } });
      // Plugin 4xx are expected client faults — not server errors. Do NOT forward
      // them to the error tracker (R2.7); return without capturing.
      return;
    }
    const { status, body } = toErrorBody(err, deps.redact);
    reply.code(status).send(body);
    // Error tracking (R2.1, R2.5): forward AFTER the response is sent, as a
    // fire-and-forget call that never blocks or alters the response. The tracker
    // itself filters expected client faults via `shouldForward` (AppError 4xx are
    // dropped), so only genuine server errors (500/502, non-AppError) reach the
    // error-tracking service. The request-id correlates the forwarded error to
    // its originating request.
    deps.services.errorTracker.capture(err, { requestId: request.requestId });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // --- Operational metrics (Requirement 1) -----------------------------------
  // Dependency-OPTIONAL: when no scrape token is configured, `services.metrics`
  // is undefined — the `/metrics` route is not registered (404) and the hook /
  // sampler below are skipped, so the app starts and serves normally (R1.2).
  const metrics = deps.services.metrics;
  if (metrics) {
    // Register the protected `/metrics` endpoint (scrape-token gated; the JWT
    // gate is bypassed via the public allow-list — see authMiddleware).
    registerMetrics(app, { collector: metrics, scrapeToken: deps.services.metricsScrapeToken });

    // Per-response HTTP metrics (request count + latency). The label is the
    // REGISTERED route PATTERN (e.g. `/api/leads/:id`) — never the concrete
    // request URL — so no label is derived from request input and cardinality
    // stays bounded (R1.6, R1.8). `reply.elapsedTime` is milliseconds.
    app.addHook('onResponse', async (request, reply): Promise<void> => {
      const routeLabel = request.routeOptions?.url ?? 'unknown';
      const durationSeconds =
        typeof reply.elapsedTime === 'number' && Number.isFinite(reply.elapsedTime)
          ? reply.elapsedTime / 1000
          : 0;
      metrics.observeHttp(routeLabel, statusClassOf(reply.statusCode), durationSeconds);
    });

    // Event-loop lag sampler (R1.3). `monitorEventLoopDelay` gives a monotonic,
    // high-resolution measurement; we publish the mean since the previous reset
    // (in milliseconds) once per second. `unref()` so this timer never keeps the
    // process alive, and it is stopped on app close.
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
    eventLoopMonitor.enable();
    const lagTimer = setInterval(() => {
      // `.mean` is in nanoseconds; convert to milliseconds.
      const meanMs = eventLoopMonitor.mean / 1e6;
      metrics.setEventLoopLagMs(meanMs);
      eventLoopMonitor.reset();
    }, 1000);
    lagTimer.unref();
    app.addHook('onClose', async (): Promise<void> => {
      clearInterval(lagTimer);
      eventLoopMonitor.disable();
    });
  }

  const { registry, tokenManager, alerts, gemini, mediaService, eventBus, aiTelemetry, assistantCompleter, assistantStreamer, assistantEmbedder, mediaRenderProvider, aiQuota } =
    deps.services;

  // Single shared oversight emit point (design §5, Req 10.4): every supervised
  // Important_Action funnels through ONE OversightService so it appends exactly
  // one ActivityLog and fans out one Notification per ADMIN + one realtime
  // event on the SAME `eventBus` the rest of the app publishes on. It is
  // injected (optionally) into LeadService / CandidateService /
  // DocumentChecklistService via their route registrars below.
  const activityLogger = new ActivityLogger(deps.prisma);
  const oversight = new OversightService(
    deps.prisma,
    activityLogger,
    new NotificationService(deps.prisma, eventBus),
  );

  // Best-effort sink for denied authorization decisions (Req 7.2, 7.3). Wrapping
  // the SAME shared ActivityLogger, it appends one `AUTHZ_DENIED` record per 403
  // and is injected into the route registrars' rbacGuards below. Fire-and-forget:
  // a logging failure never blocks or fails the denied response.
  const authzAuditor = new AuthorizationAuditor(activityLogger);

  // --- Register routes (foundation/leads/dashboard first) --------------------
  await registerRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, config, eventBus, oversight });
  registerPlatformTokenRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, config, tokenManager, activityLogger });
  await registerContentRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    config,
    gemini,
    registry,
    tokenManager,
    alerts,
    mediaService,
    eventBus,
  });
  await registerAnalyticsRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    config,
    gemini,
    registry,
    tokenManager,
    alerts,
    eventBus,
  });

  // Public API manifest / gateway info (/api/v1).
  registerApiInfo(app);

  // Real-time transports (SSE + WebSocket), fed by the shared event bus. They
  // authenticate via a query-string token (see REALTIME_PUBLIC_PATHS).
  await registerRealtime(app, { jwt: deps.jwt, prisma: deps.prisma, eventBus });

  // Agentic orchestration routes (/api/v1/workflows). The generation and
  // scheduling services are wired from the shared composition so the content
  // pipeline steps produce real drafts / schedule real posts.
  const generationService = new GenerationService(
    deps.prisma,
    gemini,
    new PrismaAiPromptContextReader(deps.prisma),
  );
  const schedulingService = new SchedulingService(
    deps.prisma,
    mediaService,
    undefined,
    eventBus,
  );
  registerOrchestrationRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    eventBus,
    generationService,
    schedulingService,
    gemini,
  });

  // AI recruitment-consultant agent + knowledge base (/api/v1/ai, /api/v1/knowledge).
  // Gemini-optional: when no key is configured the agent returns grounded fallbacks.
  registerRecruitmentAgentRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    gemini,
    oversight,
  });

  // Recruitment CRM (labor-export / XKLĐ): job orders + candidate pipeline.
  await registerRecruitmentRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, eventBus, oversight, auditor: authzAuditor });

  // Company reporting (weekly/monthly): generate / list / get / edit / transition
  // / export, all behind requireAuth + rbacGuard inside the registrar (Req 5.1–
  // 5.3, 15.5). `gemini` is threaded through so AI summaries work when a key is
  // configured; absent it the service falls back to deterministic summaries.
  registerReportingRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, gemini });

  // Candidate document checklist + document-type catalog (Req 13.6, 15.5). All
  // routes mount behind requireAuth + rbacGuard inside the registrar; SALES is
  // assigned-only on candidate-scoped routes and denied on the ADMIN catalog.
  await registerDocumentRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, oversight, auditor: authzAuditor });

  // Oversight: persistent notifications + append-only activity feed
  // (/api/v1/notifications*, /api/v1/activity). All routes mount behind
  // requireAuth + rbacGuard inside the registrar; the activity feed is
  // ADMIN-only (dashboard/company_stats) while notification reads are self-
  // scoped (dashboard/read). The shared eventBus is threaded so notification
  // creation publishes one realtime `notification` frame.
  await registerOversightRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, eventBus, auditor: authzAuditor });

  // Staff account management (ADMIN-only): list / create SALES / lock / unlock /
  // change role / reset password (/api/v1/users*). All routes mount behind
  // requireAuth + rbacGuard({ module: 'user_management' }) inside the registrar,
  // so SALES is denied 403 outright.
  registerUserManagementRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, auditor: authzAuditor });

  // Privacy & consent (ADMIN-only, settings module): append-only consent ledger
  // (incl. CROSS_BORDER_AI transfer consent) + right-to-erasure for a data
  // subject (lead / candidate / intake). Closes GDPR-style gaps surfaced in a
  // security review.
  registerPrivacyRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, auditor: authzAuditor });

  // AI marketing autopilot:
  //  - trend research + per-market content planning (/api/v1/trends, /content-plans)
  //  - multi-format content generation (/api/v1/generation/multi-format)
  //  - brand-template visual/video asset generation (/api/v1/assets, /brand-templates)
  //
  // Ground EVERY marketing AI generator in the Thanh Giang knowledge base (the
  // same curated KB the recruitment consultant uses), so all AI output is
  // factually on-brand. ONE shared provider is built here and threaded into the
  // content / planning / autopilot registrars. The grounding is optional and
  // non-breaking inside each generator (degrades to a company-identity line).
  const brandKnowledge = new KnowledgeBrandProvider(new KnowledgeService(deps.prisma));
  registerMarketingPlanningRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, gemini, brandKnowledge });
  registerMultiFormatRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, gemini, brandKnowledge, aiQuota, alerts });
  registerAssetRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    renderProvider: mediaRenderProvider,
  });
  // On-demand render trigger: POST /api/v1/assets/:id/render (call khi có lệnh
  // tạo ảnh). 502 when no provider is wired; RENDERED/FAILED otherwise.
  registerAssetRenderRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    renderProvider: mediaRenderProvider,
  });
  // Autopilot: the end-to-end data-driven loop (research → plan → generate →
  // assets → human review gate → schedule → summary).
  registerAutopilotRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    eventBus,
    gemini,
    renderProvider: mediaRenderProvider,
    brandKnowledge,
  });

  // Partners (đối tác đã hợp tác) + destination programs (nơi đưa đi XKLĐ +
  // điều kiện). ADMIN manages (settings/update); SALES reads (lead_management/read).
  await registerPartnerRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, auditor: authzAuditor });

  // Omni-channel conversational intake (Facebook Messenger + Zalo OA chatbot):
  // public HMAC-verified webhooks drive the dossier-collection flow, land a Lead
  // in the central system, and a no-op sender degrades gracefully when no
  // messaging tokens are configured. The MessagingChannelSender reuses the
  // platform token provider so outbound replies work once tokens are present.
  const channelSender = new MessagingChannelSender({ tokens: tokenManager });
  await registerIntakeRoutes(app, {
    prisma: deps.prisma,
    jwt: deps.jwt,
    config,
    eventBus,
    sender: channelSender,
    auditor: authzAuditor,
  });

  // Visa Smart Checklist + logistics plan + destination suggestions (đối chiếu
  // DB & gợi ý cho tư vấn). All behind requireAuth + rbacGuard(lead_management).
  await registerVisaRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, gemini, auditor: authzAuditor });

  // Study-abroad enhancements:
  //  - Scholarship & financial matching (ngân sách + GPA + IELTS → học bổng/chi
  //    phí ròng → gợi ý cho tư vấn).
  //  - Behavior-based follow-up nurture (drop-off → tin nhắn cá nhân hóa qua kênh).
  await registerScholarshipRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, auditor: authzAuditor });
  await registerFollowUpRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, sender: channelSender, auditor: authzAuditor });

  // Study-abroad AI advisor suite (additive, all behind requireAuth + rbacGuard;
  // SALES assigned-only via candidate.assignedTo, Gemini-optional with
  // deterministic fallbacks):
  //  - Admissions: academic profile + Reach/Match/Safety scoring + gap suggestions.
  //  - Essays: SOP/motivation/CV writer + rubric reviewer + REVIEW MODE lifecycle.
  //  - Interview prep: grounded visa-interview question sets + answer scoring.
  //  - Applications: multi-application cases + merged proactive deadline timeline.
  //  - Roadmap: study→career→PR ROI estimate + readiness scoring + REVIEW MODE narrative.
  await registerAdmissionsRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, auditor: authzAuditor });
  await registerEssayRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, gemini, auditor: authzAuditor });
  await registerInterviewPrepRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, gemini, auditor: authzAuditor });
  await registerApplicationRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, oversight, auditor: authzAuditor });
  await registerRoadmapRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, gemini, auditor: authzAuditor });

  // AgentOps: ADMIN-only read of the AI-text-call telemetry window (fallback
  // rate, latency percentiles, error-code breakdown) — observability for the
  // DeepSeek migration. Read-only; SALES is denied 403 by company_stats policy.
  await registerAiTelemetryRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, aiTelemetry });

  // Grounded assistant with tools (reusable use-case): ADMIN+SALES grounded Q&A
  // over the KnowledgeBase, AI-OPTIONAL with a deterministic fallback, governed
  // tool use via the allow-list. Completer is undefined when AI is unconfigured.
  await registerAssistantRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, completer: assistantCompleter, streamer: assistantStreamer, embedder: assistantEmbedder, aiQuota, alerts });

  // Compliance dashboard: audit reports, PII exposure, retention status, consent
  // overview, workload protection, DSAR tracking. ADMIN-only (settings/read).
  registerGovernanceRoutes(app, { prisma: deps.prisma, jwt: deps.jwt, auditor: authzAuditor });

  return app;
}
