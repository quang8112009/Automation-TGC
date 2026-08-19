/**
 * governance/routes — Compliance dashboard API endpoints.
 *
 * Provides read-only endpoints for the governance dashboard:
 *   - GET /api/v1/governance/overview        — Full dashboard overview
 *   - GET /api/v1/governance/audit           — Audit log summary
 *   - GET /api/v1/governance/pii             — PII exposure report
 *   - GET /api/v1/governance/retention       — Data retention status
 *   - GET /api/v1/governance/consent         — Consent overview
 *   - GET /api/v1/governance/protection      — Workload protection summary
 *   - GET /api/v1/governance/dsar            — DSAR request summary
 *   - POST /api/v1/governance/export         — Export full report as JSON
 *
 * All endpoints are ADMIN-only (settings/read RBAC).
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { getAuth, rbacGuard, requireAuth } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import { ComplianceDashboard } from './dashboard';
import { getComplianceMetrics } from './metrics';
import { exportComplianceCSV, exportCompliancePDF, type CSVSection } from './export';

export interface GovernanceRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  auditor?: RbacAuditor;
}

function parseTimeRange(query: Record<string, unknown>): { from?: string; to?: string } {
  const from = typeof query.from === 'string' ? query.from : undefined;
  const to = typeof query.to === 'string' ? query.to : undefined;
  return { from, to };
}

export function registerGovernanceRoutes(app: FastifyInstance, deps: GovernanceRouteDeps): void {
  const { prisma, jwt, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const dashboard = new ComplianceDashboard(prisma);

  // ADMIN-only: settings/read policy.
  const readGuard = rbacGuard(() => ({ module: 'settings', action: 'read' }), auditor);

  // GET /api/v1/governance/overview — Full dashboard overview.
  app.get(
    '/api/v1/governance/overview',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const range = parseTimeRange((request.query ?? {}) as Record<string, unknown>);
      const overview = await dashboard.getOverview(range);
      return reply.code(200).send(overview);
    },
  );

  // GET /api/v1/governance/audit — Audit log summary.
  app.get(
    '/api/v1/governance/audit',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const range = parseTimeRange((request.query ?? {}) as Record<string, unknown>);
      const summary = await dashboard.getAuditSummary(range);
      return reply.code(200).send(summary);
    },
  );

  // GET /api/v1/governance/pii — PII exposure report.
  app.get(
    '/api/v1/governance/pii',
    { preHandler: [auth, readGuard] },
    async (_request, reply) => {
      const report = await dashboard.getPiiExposureReport();
      return reply.code(200).send(report);
    },
  );

  // GET /api/v1/governance/retention — Data retention status.
  app.get(
    '/api/v1/governance/retention',
    { preHandler: [auth, readGuard] },
    async (_request, reply) => {
      const status = await dashboard.getRetentionStatus();
      return reply.code(200).send(status);
    },
  );

  // GET /api/v1/governance/consent — Consent overview.
  app.get(
    '/api/v1/governance/consent',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const range = parseTimeRange((request.query ?? {}) as Record<string, unknown>);
      const overview = await dashboard.getConsentOverview(range);
      return reply.code(200).send(overview);
    },
  );

  // GET /api/v1/governance/protection — Workload protection summary.
  app.get(
    '/api/v1/governance/protection',
    { preHandler: [auth, readGuard] },
    async (_request, reply) => {
      const summary = await dashboard.getProtectionSummary();
      return reply.code(200).send(summary);
    },
  );

  // GET /api/v1/governance/dsar — DSAR request summary.
  app.get(
    '/api/v1/governance/dsar',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const range = parseTimeRange((request.query ?? {}) as Record<string, unknown>);
      const summary = await dashboard.getDsarSummary(range);
      return reply.code(200).send(summary);
    },
  );

  // POST /api/v1/governance/export — Export full compliance report as JSON.
  app.post(
    '/api/v1/governance/export',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const range = parseTimeRange(body);
      const overview = await dashboard.getOverview(range);

      // Set content-disposition for download.
      const filename = `compliance-report-${new Date().toISOString().slice(0, 10)}.json`;
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Content-Type', 'application/json');

      return reply.code(200).send(overview);
    },
  );

  // ── Alerting endpoints ─────────────────────────────────────────────────
  const alerter = dashboard.getAlerter();

  // GET /api/v1/governance/alerts — Alert history.
  app.get(
    '/api/v1/governance/alerts',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const alerts = await alerter.getAlertHistory({
        limit: typeof q.limit === 'string' ? Math.min(Number(q.limit) || 50, 200) : 50,
        severity: typeof q.severity === 'string' ? (q.severity as 'info' | 'warning' | 'critical') : undefined,
        type: typeof q.type === 'string' ? (q.type as never) : undefined,
        since: typeof q.since === 'string' ? q.since : undefined,
      });
      return reply.code(200).send({ alerts });
    },
  );

  // GET /api/v1/governance/alerts/stats — Alert statistics.
  app.get(
    '/api/v1/governance/alerts/stats',
    { preHandler: [auth, readGuard] },
    async (_request, reply) => {
      const stats = await alerter.getAlertStats();
      return reply.code(200).send(stats);
    },
  );

  // POST /api/v1/governance/alerts/test — Send a test alert (admin only).
  app.post(
    '/api/v1/governance/alerts/test',
    { preHandler: [auth, readGuard] },
    async (_request, reply) => {
      const result = await alerter.evaluate(100, {});
      return reply.code(200).send({
        message: 'Test alert evaluation completed',
        alertsFired: result.alerts.length,
        score: result.score,
      });
    },
  );

  // ── Prometheus /metrics endpoint ────────────────────────────────────
  const metrics = getComplianceMetrics();
  metrics.setAlertCooldown(alerter['thresholds'].cooldownMs);

  // GET /api/v1/governance/metrics — Prometheus exposition format.
  // No auth required (Prometheus needs to scrape this unauthenticated).
  // Mounted at a separate path to avoid conflicting with the auth-guarded routes.
  app.get(
    '/api/v1/governance/metrics',
    async (_request, reply) => {
      const body = await metrics.getMetrics();
      reply.header('Content-Type', metrics.getContentType());
      return reply.code(200).send(body);
    },
  );

  // ── Export endpoints ──────────────────────────────────────────────────

  // GET /api/v1/governance/export/csv — Export compliance report as CSV.
  app.get(
    '/api/v1/governance/export/csv',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const range = parseTimeRange(q);
      const section = (typeof q.section === 'string' ? q.section : 'all') as CSVSection;
      const overview = await dashboard.getOverview(range);
      const alerts = await alerter.getAlertHistory({ limit: 50 });
      const result = exportComplianceCSV(overview, section, alerts);
      reply.header('Content-Type', result.mimeType);
      reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
      return reply.code(200).send(result.content);
    },
  );

  // GET /api/v1/governance/export/pdf — Export compliance report as PDF.
  app.get(
    '/api/v1/governance/export/pdf',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const range = parseTimeRange(q);
      const overview = await dashboard.getOverview(range);
      const alerts = await alerter.getAlertHistory({ limit: 50 });
      const result = await exportCompliancePDF(overview, alerts);
      reply.header('Content-Type', result.mimeType);
      reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
      return reply.code(200).send(result.content);
    },
  );
}
