/**
 * API gateway info / route manifest.
 *
 * Exposes a single public, unauthenticated `GET /api/v1` endpoint that documents
 * the gateway surface: the API version and the available route groups (with
 * their base path prefixes). This is descriptive only — it neither changes nor
 * proxies any existing route, so the deployed system and tests are unaffected.
 *
 * The path is registered in the auth allow-list (API_INFO_PUBLIC_PATHS) so it
 * never requires a token.
 */
import type { FastifyInstance } from 'fastify';

/** Public path for the API manifest (added to the auth allow-list). */
export const API_INFO_PUBLIC_PATHS: readonly string[] = ['/api/v1'];

/** Current API version surfaced by the manifest. */
export const API_VERSION = 'v1';

interface RouteGroup {
  name: string;
  basePath: string;
  description: string;
}

/** Static manifest of the route groups the gateway exposes. */
const ROUTE_GROUPS: readonly RouteGroup[] = [
  { name: 'auth', basePath: '/api/auth', description: 'Authentication: register, login, refresh, logout' },
  { name: 'leads', basePath: '/api/leads', description: 'Lead management CRUD, stats, export, and webhooks' },
  { name: 'dashboard', basePath: '/api/dashboard', description: 'Operational dashboard overview and notifications' },
  { name: 'platform_tokens', basePath: '/api/platforms', description: 'Platform token metadata and lifecycle' },
  { name: 'strategy', basePath: '/api/strategy', description: 'Content strategy: personas, calendar, AI context' },
  { name: 'generation', basePath: '/api/generation', description: 'Content generation, drafts, and review' },
  { name: 'media', basePath: '/api/media', description: 'Draft media attachments' },
  { name: 'publishing', basePath: '/api/publishing', description: 'Scheduling and publishing of approved drafts' },
  { name: 'analytics', basePath: '/api/analytics', description: 'Metric collection and post performance scoring' },
  { name: 'feedback', basePath: '/api/feedback', description: 'Feedback loop: analysis and learning-insight review' },
  { name: 'workflows', basePath: '/api/v1/workflows', description: 'Agentic orchestration: content pipeline runs' },
  { name: 'realtime', basePath: '/api/v1/stream, /api/v1/ws', description: 'Real-time updates via SSE and WebSocket' },
  { name: 'job_orders', basePath: '/api/v1/job-orders', description: 'Recruitment job orders (đơn hàng XKLĐ)' },
  { name: 'candidates', basePath: '/api/v1/candidates', description: 'Recruitment candidate pipeline (ứng viên)' },
  { name: 'ai_consultant', basePath: '/api/v1/ai', description: 'AI recruitment consultant: consult, suggest job orders, draft outreach' },
  { name: 'knowledge', basePath: '/api/v1/knowledge', description: 'Knowledge base grounding the recruitment AI agent' },
  { name: 'trends', basePath: '/api/v1/trends', description: 'AI market trend / keyword research per market' },
  { name: 'content_plans', basePath: '/api/v1/content-plans', description: 'Per-market AI content plans (Japan/Korea/Germany/Taiwan/Australia/Lithuania/Europe...)' },
  { name: 'multi_format', basePath: '/api/v1/generation/multi-format', description: 'Multi-format AI generation: SEO, caption, video script, email, care message, chatbot FAQ' },
  { name: 'brand_templates', basePath: '/api/v1/brand-templates', description: 'Brand templates for visual/video assets' },
  { name: 'assets', basePath: '/api/v1/assets', description: 'Brand-template visual/video asset generation (thumbnail/infographic/poster/short video)' },
  { name: 'autopilot', basePath: '/api/v1/autopilot', description: 'End-to-end marketing autopilot: research → plan → generate → assets → review → schedule' },
];

/**
 * Register the public API manifest endpoint. Additive and non-breaking: it does
 * not touch any existing route registration.
 */
export function registerApiInfo(app: FastifyInstance): void {
  app.get('/api/v1', async () => ({
    name: 'AutoTGC API',
    version: API_VERSION,
    routeGroups: ROUTE_GROUPS,
  }));
}
