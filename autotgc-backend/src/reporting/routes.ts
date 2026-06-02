/**
 * Company-report route registration (ai-reporting-and-ops-enhancements,
 * Req 5.1, 5.2, 5.3, 15.5).
 *
 * Thin Fastify layer: it shapes requests/responses, wires auth + RBAC, and
 * delegates every decision to `ReportService`. It mirrors the registration
 * style of `recruitment/agent/routes.ts` and `recruitment/documents/routes.ts`
 * (requireAuth + rbacGuard + getAuth) and uses the `/api/v1` gateway prefix.
 *
 * RBAC mapping — keeping `auth/rbac.ts` pure (Req 5.1–5.3):
 *   - Write surfaces (`generate`/`update`/`transition`) map to the `analytics`
 *     module. The pure policy already grants ADMIN everything and denies SALES
 *     on `analytics`, so SALES is rejected with 403 at the guard (and again,
 *     defensively, inside the service).
 *   - Read surfaces (`list`/`get`/`export`) must be reachable by SALES too, but
 *     `analytics`/`read` denies SALES under the current policy. So the read
 *     guard maps ADMIN → `analytics`/`read` (full data) and SALES →
 *     `dashboard`/`read` (which the policy permits). The APPROVED-only
 *     restriction for SALES (Req 5.2) is then enforced entirely by the service
 *     (`ReportService.get`/`list`/`export` filter or 403 on non-APPROVED). This
 *     is the same dashboard/read mapping the Work_Assistant route uses and it
 *     never widens SALES write access.
 *
 * This file is additive; wiring into `app.ts` is task 9.1.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { ContentGenerator } from '../strategy/personaService';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import { ValidationError } from '../infra/errors';
import { ReportService } from './reportService';
import type { ReportListFilter } from './reportService';
import type { ReportStatus } from './reportStateMachine';
import type { ReportContent, ReportPeriod, ReportType } from './types';

export interface ReportingRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Optional Gemini seam; when absent the service uses deterministic summaries. */
  gemini?: ContentGenerator;
}

interface IdParams {
  id: string;
}

const REPORT_TYPES: ReadonlySet<ReportType> = new Set<ReportType>(['WEEKLY', 'MONTHLY']);
const REPORT_STATUSES: ReadonlySet<ReportStatus> = new Set<ReportStatus>([
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'ARCHIVED',
  'INSUFFICIENT_DATA',
]);

/** Narrow an unknown value to a non-empty (trimmed) string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Narrow an unknown value to a valid ReportType, else undefined. */
function asReportType(v: unknown): ReportType | undefined {
  const s = asString(v);
  return s !== undefined && REPORT_TYPES.has(s as ReportType) ? (s as ReportType) : undefined;
}

/** Narrow an unknown value to a valid ReportStatus, else undefined. */
function asReportStatus(v: unknown): ReportStatus | undefined {
  const s = asString(v);
  return s !== undefined && REPORT_STATUSES.has(s as ReportStatus) ? (s as ReportStatus) : undefined;
}

/** Parse a string/number into a valid Date, else undefined. */
function asDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Monday 00:00:00 UTC of the week containing `d`. */
function weekStartUtc(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (day.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  day.setUTCDate(day.getUTCDate() - dayNum);
  return day;
}

/** ISO-8601 {year, week} for a date (UTC). */
function isoWeekParts(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: date.getUTCFullYear(), week };
}

/**
 * Compute the just-ended period for a report type relative to `now` (UTC).
 * WEEKLY → the previous ISO week [Mon, Mon); MONTHLY → the previous calendar
 * month [1st, 1st). Used when the request omits an explicit period.
 */
function previousPeriod(type: ReportType, now: Date): ReportPeriod {
  if (type === 'WEEKLY') {
    const thisWeek = weekStartUtc(now);
    const from = new Date(thisWeek.getTime() - 7 * 86_400_000);
    const to = thisWeek;
    const { year, week } = isoWeekParts(from);
    return { label: `${year}-W${String(week).padStart(2, '0')}`, from, to };
  }
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const label = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
  return { label, from, to };
}

/**
 * Validate an explicit period payload. Requires a non-empty label and valid
 * from/to dates with from < to; anything else is a 400 (Req 5.1 bad input).
 */
function parseProvidedPeriod(value: unknown): ReportPeriod {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('period must be an object', 'REPORT_PERIOD_INVALID');
  }
  const p = value as Record<string, unknown>;
  const label = asString(p.label);
  const from = asDate(p.from);
  const to = asDate(p.to);
  if (!label) throw new ValidationError('period.label is required', 'REPORT_PERIOD_LABEL_REQUIRED');
  if (!from) throw new ValidationError('period.from is invalid', 'REPORT_PERIOD_FROM_INVALID');
  if (!to) throw new ValidationError('period.to is invalid', 'REPORT_PERIOD_TO_INVALID');
  if (from.getTime() >= to.getTime()) {
    throw new ValidationError('period.from must be before period.to', 'REPORT_PERIOD_RANGE_INVALID');
  }
  return { label, from, to };
}

export function registerReportingRoutes(app: FastifyInstance, deps: ReportingRouteDeps): void {
  const { prisma, jwt, gemini } = deps;
  const service = new ReportService(prisma, gemini);
  const auth = requireAuth({ prisma, jwt });

  // Write guards on the `analytics` module: ADMIN passes, SALES is denied (403)
  // by the pure policy. (Req 5.1, 5.3)
  const createGuard = rbacGuard(() => ({ module: 'analytics', action: 'create' }));
  const updateGuard = rbacGuard(() => ({ module: 'analytics', action: 'update' }));
  const statusGuard = rbacGuard(() => ({ module: 'analytics', action: 'status_update' }));

  // Read guard: ADMIN → analytics/read (full data); SALES → dashboard/read so
  // the guard lets SALES through (Req 5.2). The service then restricts SALES to
  // APPROVED reports. This keeps `rbac.ts` pure and never widens SALES writes.
  const readGuard = rbacGuard((request: FastifyRequest) => {
    const { role } = getAuth(request);
    return role === 'SALES'
      ? { module: 'dashboard', action: 'read' }
      : { module: 'analytics', action: 'read' };
  });

  // ---- POST /api/v1/reports/generate ----------------------------------------
  // Manually generate a report for a reportType + period. analytics/create
  // (ADMIN). If `period` is omitted, the just-ended period is computed; bad
  // input → 400. (Req 5.1)
  app.post(
    '/api/v1/reports/generate',
    { preHandler: [auth, createGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;

      const reportType = asReportType(body.reportType);
      if (!reportType) {
        throw new ValidationError(
          'reportType must be WEEKLY or MONTHLY',
          'REPORT_TYPE_INVALID',
        );
      }

      const period =
        body.period === undefined || body.period === null
          ? previousPeriod(reportType, new Date())
          : parseProvidedPeriod(body.period);

      const view = await service.generateForPeriod(reportType, period, {
        role: actor.role,
        userId: actor.userId,
      });
      return reply.code(201).send(view);
    },
  );

  // ---- GET /api/v1/reports --------------------------------------------------
  // List reports filtered by reportType/status. SALES is restricted to APPROVED
  // by the service regardless of the requested filter (Req 5.2).
  app.get(
    '/api/v1/reports',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const query = (request.query ?? {}) as Record<string, unknown>;

      const filter: ReportListFilter = {};
      if (query.reportType !== undefined) {
        const reportType = asReportType(query.reportType);
        if (!reportType) {
          throw new ValidationError('reportType filter is invalid', 'REPORT_TYPE_INVALID');
        }
        filter.reportType = reportType;
      }
      if (query.status !== undefined) {
        const status = asReportStatus(query.status);
        if (!status) {
          throw new ValidationError('status filter is invalid', 'REPORT_STATUS_INVALID');
        }
        filter.status = status;
      }

      const result = await service.list(filter, actor);
      return reply.code(200).send(result);
    },
  );

  // ---- GET /api/v1/reports/:id ----------------------------------------------
  // Read a single report. SALES reading a non-APPROVED report → 403 (service).
  app.get(
    '/api/v1/reports/:id',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const view = await service.get(id, actor);
      return reply.code(200).send(view);
    },
  );

  // ---- PUT /api/v1/reports/:id ----------------------------------------------
  // Edit report content. analytics/update (ADMIN); SALES → 403 (guard + service).
  // Only DRAFT/IN_REVIEW are editable; other statuses → 409 (service).
  app.put(
    '/api/v1/reports/:id',
    { preHandler: [auth, updateGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      if (typeof request.body !== 'object' || request.body === null) {
        throw new ValidationError('Report content payload is required', 'REPORT_CONTENT_INVALID');
      }
      const content = request.body as Partial<ReportContent>;
      const view = await service.updateContent(id, content, actor);
      return reply.code(200).send(view);
    },
  );

  // ---- POST /api/v1/reports/:id/transition ----------------------------------
  // Drive the report through the guarded state machine. analytics/status_update
  // (ADMIN); SALES → 403. Illegal transition → 409 (service). Body: { target }.
  app.post(
    '/api/v1/reports/:id/transition',
    { preHandler: [auth, statusGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = asReportStatus(body.target);
      if (!target) {
        throw new ValidationError('target must be a valid report status', 'REPORT_TARGET_INVALID');
      }
      const view = await service.transition(id, target, actor);
      return reply.code(200).send(view);
    },
  );

  // ---- GET /api/v1/reports/:id/export ---------------------------------------
  // Download an APPROVED report as structured text/markdown. Non-APPROVED → 409
  // (service); SALES reading a non-APPROVED report → 403 (service). The
  // content-type and attachment filename come straight from the export result.
  app.get(
    '/api/v1/reports/:id/export',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const actor = getAuth(request);
      const { id } = request.params as IdParams;
      const result = await service.export(id, actor);
      reply.header('Content-Type', result.contentType);
      reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
      return reply.code(200).send(result.body);
    },
  );
}
