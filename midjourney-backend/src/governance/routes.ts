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
}
