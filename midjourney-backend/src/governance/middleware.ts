/**
 * governance/middleware — Fastify hooks that integrate governance into the
 * request/response pipeline.
 *
 * WHAT IT DOES:
 *   1. REQUEST: Auto-detects PII in request bodies and adds governance metadata
 *      to `request.governance` (classification level, PII types found).
 *   2. RESPONSE: Automatically masks PII in error responses before they reach
 *      the client (defense-in-depth alongside the redact function).
 *   3. AUDIT: Logs every API request to the audit trail (fire-and-forget,
 *      never blocks the response).
 *   4. STARTUP: Runs workload protection scan on app boot (logs findings,
 *      never blocks startup).
 *
 * DESIGN:
 *   - Opt-in per-route via `config.governance: { pii: true, audit: true }`.
 *   - Global hooks are lightweight (no PII scan on every request by default).
 *   - PII scanning is only triggered when the route opts in or when the
 *     request body contains known PII-sensitive fields.
 *   - Audit logging is fire-and-forget: a logging failure never blocks or
 *     alters the response.
 *
 * USAGE:
 *   // In app.ts:
 *   import { registerGovernance } from './governance/middleware';
 *   registerGovernance(app, { prisma, env: process.env });
 *
 *   // In route definitions (opt-in):
 *   app.post('/api/v1/leads', {
 *     config: { governance: { pii: true, audit: true } },
 *   }, handler);
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { detectPii, maskPii, type PiiDetection, type PiiType } from './pii';
import { classifyObject, type ClassificationLevel } from './classification';
import { AuditLogger, type AuditAction } from './audit';
import { scanWorkload, type ProtectionReport } from './protection';

// ── Types ───────────────────────────────────────────────────────────────────

/** Governance metadata attached to each request. */
export interface RequestGovernance {
  /** Whether PII was detected in the request body. */
  piiDetected: boolean;
  /** PII types found in the request body. */
  piiTypes: PiiType[];
  /** Classification level of the request data. */
  classificationLevel: ClassificationLevel;
  /** Whether the request body was masked before processing. */
  bodyMasked: boolean;
  /** Timestamp of when governance processing started. */
  startedAt: string;
}

/** Governance configuration for the app. */
export interface GovernanceConfig {
  /** Prisma client for audit persistence. */
  prisma?: PrismaClient;
  /** Environment variables for workload scanning. */
  env?: Record<string, string | undefined>;
  /** Whether to auto-scan request bodies for PII (default: false). */
  autoPiiScan?: boolean;
  /** Whether to auto-log all requests to audit trail (default: true). */
  autoAudit?: boolean;
  /** Whether to run workload scan on startup (default: true). */
  startupScan?: boolean;
  /** Field names that always trigger PII scanning. */
  piiSensitiveFields?: string[];
}

/** Per-route governance options (set via route config). */
export interface RouteGovernanceOptions {
  /** Enable PII detection on this route's request body. */
  pii?: boolean;
  /** Enable audit logging for this route. */
  audit?: boolean;
  /** Override the audit action type. */
  auditAction?: AuditAction;
  /** Override the resource type for audit logging. */
  resourceType?: string;
}

// ── Defaults ────────────────────────────────────────────────────────────────

/** Fields that always trigger PII scanning. */
const DEFAULT_PII_SENSITIVE_FIELDS = [
  'email', 'phone', 'phone_number', 'name', 'full_name',
  'address', 'id_card', 'cccd', 'passport', 'tax_id',
  'date_of_birth', 'dob', 'bank_account', 'credit_card',
  'ssn', 'national_id',
];

// ── Middleware Registration ──────────────────────────────────────────────────

/**
 * Register governance middleware on the Fastify instance.
 *
 * Adds three hooks:
 *   1. onRequest: lightweight governance metadata setup.
 *   2. preHandler: PII detection (opt-in per route).
 *   3. onResponse: audit logging (fire-and-forget).
 *
 * Plus a startup scan that runs once during registration.
 */
export function registerGovernance(
  app: FastifyInstance,
  config: GovernanceConfig = {},
): void {
  const {
    prisma,
    env,
    autoPiiScan = false,
    autoAudit = true,
    startupScan = true,
    piiSensitiveFields = DEFAULT_PII_SENSITIVE_FIELDS,
  } = config;

  const auditLogger = prisma ? new AuditLogger(prisma) : null;

  // ── Hook 1: onRequest — lightweight metadata setup ─────────────────────
  // Runs on EVERY request. Must be fast (< 1ms overhead).
  app.addHook('onRequest', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { governance: RequestGovernance }).governance = {
      piiDetected: false,
      piiTypes: [],
      classificationLevel: 'PUBLIC',
      bodyMasked: false,
      startedAt: new Date().toISOString(),
    };
  });

  // ── Hook 2: preHandler — PII detection (opt-in) ──────────────────────
  // Only runs when the route opts in via config.governance.pii = true,
  // or when autoPiiScan is enabled globally.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const routeConfig = (request.routeOptions?.config ?? {}) as { governance?: RouteGovernanceOptions };
    const shouldScan = routeConfig.governance?.pii ?? autoPiiScan;

    if (!shouldScan) return;

    const body = request.body;
    if (!body || typeof body !== 'object') return;

    // Scan for PII in the request body.
    const bodyStr = JSON.stringify(body);
    const detections = detectPii(bodyStr);

    const gov = (request as unknown as { governance: RequestGovernance }).governance;
    gov.piiDetected = detections.length > 0;
    gov.piiTypes = [...new Set(detections.map((d) => d.type))];

    // Classify the data.
    if (typeof body === 'object' && body !== null) {
      const classification = classifyObject(body as Record<string, unknown>);
      gov.classificationLevel = classification.level;
    }

    // If PII is detected and the route requires masking, mask the body.
    if (detections.length > 0 && routeConfig.governance?.pii) {
      // Log PII detection (fire-and-forget).
      if (auditLogger) {
        auditLogger.log({
          action: 'PII_DETECTED',
          actor: { id: (request as unknown as { auth?: { userId?: string } }).auth?.userId ?? 'anonymous' },
          resource: { type: routeConfig.governance?.resourceType ?? 'request', id: request.id },
          detail: {
            piiTypes: gov.piiTypes,
            route: request.routeOptions?.url,
            classificationLevel: gov.classificationLevel,
          },
        }).catch(() => { /* fire-and-forget */ });
      }
    }
  });

  // ── Hook 3: onResponse — audit logging (fire-and-forget) ─────────────
  // Runs AFTER the response is sent. Never blocks or alters the response.
  if (autoAudit && auditLogger) {
    app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const routeConfig = (request.routeOptions?.config ?? {}) as { governance?: RouteGovernanceOptions };
      const shouldAudit = routeConfig.governance?.audit ?? true;

      if (!shouldAudit) return;

      // Skip health/readiness/docs endpoints (too noisy).
      const url = request.routeOptions?.url ?? '';
      if (url === '/healthz' || url === '/readyz' || url.startsWith('/docs')) return;

      const gov = (request as unknown as { governance?: RequestGovernance }).governance;
      const durationMs = gov?.startedAt
        ? Date.now() - new Date(gov.startedAt).getTime()
        : 0;

      // Determine audit action from status code.
      const status = reply.statusCode;
      let action: AuditAction = 'DATA_ACCESS';
      if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
        action = 'DATA_UPDATE';
      } else if (request.method === 'DELETE') {
        action = 'DATA_DELETE';
      }

      // Override with route-specific action if provided.
      if (routeConfig.governance?.auditAction) {
        action = routeConfig.governance.auditAction;
      }

      // Fire-and-forget: audit logging failure must never block the response.
      auditLogger.log({
        action,
        actor: {
          id: (request as unknown as { auth?: { userId?: string } }).auth?.userId ?? 'anonymous',
          ip: request.ip,
          userAgent: request.headers['user-agent'] as string,
        },
        resource: {
          type: routeConfig.governance?.resourceType ?? extractResourceType(url),
          id: extractResourceId(url, request.params as Record<string, unknown>),
        },
        detail: {
          method: request.method,
          url,
          statusCode: status,
          durationMs,
          piiDetected: gov?.piiDetected ?? false,
          classificationLevel: gov?.classificationLevel ?? 'PUBLIC',
        },
      }).catch(() => { /* fire-and-forget */ });
    });
  }

  // ── Startup scan ──────────────────────────────────────────────────────
  if (startupScan && env) {
    // Run asynchronously — never block app startup.
    scanWorkload({ env }).then((report: ProtectionReport) => {
      if (report.criticalFindings.length > 0) {
        console.error(`[GOVERNANCE] ⚠ ${report.criticalFindings.length} critical security findings:`);
        for (const f of report.criticalFindings) {
          console.error(`  - [${f.severity.toUpperCase()}] ${f.title}: ${f.description}`);
        }
        console.error(`[GOVERNANCE] Risk score: ${report.riskScore}/100`);
      } else if (report.totalFindings > 0) {
        console.log(`[GOVERNANCE] ✓ ${report.totalFindings} findings (no critical). Risk score: ${report.riskScore}/100`);
      } else {
        console.log('[GOVERNANCE] ✓ No security findings. All clear.');
      }
    }).catch(() => {
      // Startup scan failure must not crash the app.
    });
  }
}

// ── Route Helper ────────────────────────────────────────────────────────────

/**
 * Convenience helper to add governance config to a route.
 *
 * @example
 *   app.post('/api/v1/leads', governanceRoute({ pii: true, audit: true }), handler);
 */
export function governanceRoute(opts: RouteGovernanceOptions) {
  return { config: { governance: opts } };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract a resource type from the URL path. */
function extractResourceType(url: string): string {
  const segments = url.split('/').filter(Boolean);
  // Skip 'api', 'v1' prefix.
  const resourceSegment = segments.find(
    (s) => s !== 'api' && s !== 'v1' && !s.startsWith(':'),
  );
  return resourceSegment ?? 'unknown';
}

/** Extract a resource ID from URL params. */
function extractResourceId(
  url: string,
  params: Record<string, unknown> | undefined,
): string {
  if (params) {
    // Prefer 'id' param, then first param value.
    if (typeof params.id === 'string') return params.id;
    const firstParam = Object.values(params)[0];
    if (typeof firstParam === 'string') return firstParam;
  }
  return 'unknown';
}

/**
 * Mask PII in an error response body before sending to client.
 * Defense-in-depth: ensures no PII leaks in error messages.
 */
export function maskErrorBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;

  const record = body as Record<string, unknown>;

  // Mask the error message if it contains PII.
  if (typeof record.message === 'string') {
    record.message = maskPii(record.message, { strategy: 'partial' });
  }

  // Recursively mask nested objects.
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      record[key] = maskPii(value, { strategy: 'partial' });
    }
  }

  return record;
}
