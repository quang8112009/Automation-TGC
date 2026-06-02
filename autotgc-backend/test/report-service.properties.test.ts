/**
 * Property-based test for ReportService read scoping
 * (ai-reporting-and-ops-enhancements).
 *
 * Implements exactly DESIGN Property 8 and runs >= 100 generated cases on
 * fast-check. Prisma is replaced by a tiny in-memory fake that implements only
 * the `companyReport` methods ReportService actually calls (findMany, count,
 * findUnique). No Gemini seam is wired — scoping is independent of AI.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';

import { ReportService } from '../src/reporting/reportService';
import type { ReportStatus } from '../src/reporting/reportStateMachine';
import { aggregateReport } from '../src/reporting/reportEngine';
import { AppError } from '../src/infra/errors';
import type { AuthInfo } from '../src/http/authMiddleware';

const ALL_STATUSES: ReportStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'ARCHIVED',
  'INSUFFICIENT_DATA',
];

interface ReportRow {
  id: string;
  reportType: string;
  periodFrom: Date;
  periodTo: Date;
  periodLabel: string;
  status: string;
  content: unknown;
  aiGenerated: boolean;
  scopeUserId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal in-memory Prisma fake covering only `companyReport` reads. */
function makeFakePrisma(rows: ReportRow[]): PrismaClient {
  const matches = (r: ReportRow, where?: { reportType?: string; status?: string }): boolean => {
    if (!where) return true;
    if (where.reportType !== undefined && r.reportType !== where.reportType) return false;
    if (where.status !== undefined && r.status !== where.status) return false;
    return true;
  };

  return {
    companyReport: {
      findMany: async (args?: { where?: { reportType?: string; status?: string } }) =>
        rows.filter((r) => matches(r, args?.where)).map((r) => ({ ...r })),
      count: async (args?: { where?: { reportType?: string; status?: string } }) =>
        rows.filter((r) => matches(r, args?.where)).length,
      findUnique: async (args: { where: { id: string } }) => {
        const found = rows.find((r) => r.id === args.where.id);
        return found ? { ...found } : null;
      },
    },
  } as unknown as PrismaClient;
}

function makeRow(id: string, status: ReportStatus): ReportRow {
  const from = new Date('2024-01-01T00:00:00.000Z');
  const to = new Date('2024-01-08T00:00:00.000Z');
  // Structurally complete ReportContent built by the real engine so export()
  // (which serializes every field) has valid data to render.
  const content = aggregateReport([], 'WEEKLY', { label: '2024-W01', from, to });
  return {
    id,
    reportType: 'WEEKLY',
    periodFrom: from,
    periodTo: to,
    periodLabel: '2024-W01',
    status,
    content,
    aiGenerated: false,
    scopeUserId: null,
    createdBy: 'admin',
    createdAt: from,
    updatedAt: from,
  };
}

const SALES: AuthInfo = { userId: 'sales-1', role: 'SALES', sessionId: 's1' };
const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 's2' };

describe('ai-reporting-and-ops-enhancements — ReportService read scoping properties', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 8: SALES chỉ đọc được báo cáo APPROVED
  // For any set of reports with arbitrary statuses, a SALES requestor's list returns
  // exactly the APPROVED reports (and nothing else), get/export on an APPROVED report
  // succeeds, and get/export on any non-APPROVED report is rejected with status 403.
  // Validates: Requirements 5.2
  it('Property 8: SALES list/get returns only APPROVED; non-APPROVED → 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...ALL_STATUSES), { minLength: 1, maxLength: 20 }),
        async (statuses) => {
          const rows = statuses.map((s, i) => makeRow(`r${i}`, s));
          const svc = new ReportService(makeFakePrisma(rows));

          // 1. SALES list returns only APPROVED reports.
          const listed = await svc.list({}, SALES);
          const approvedIds = rows.filter((r) => r.status === 'APPROVED').map((r) => r.id).sort();
          expect(listed.items.every((v) => v.status === 'APPROVED')).toBe(true);
          expect(listed.items.map((v) => v.id).sort()).toEqual(approvedIds);
          expect(listed.total).toBe(approvedIds.length);

          // 1b. A requested non-APPROVED status filter cannot widen SALES access.
          const listedDraft = await svc.list({ status: 'DRAFT' }, SALES);
          expect(listedDraft.items.every((v) => v.status === 'APPROVED')).toBe(true);

          // 2. SALES get/export: APPROVED ok, everything else 403.
          for (const r of rows) {
            if (r.status === 'APPROVED') {
              const view = await svc.get(r.id, SALES);
              expect(view.status).toBe('APPROVED');
              await expect(svc.export(r.id, SALES)).resolves.toMatchObject({
                contentType: expect.stringContaining('text/markdown'),
              });
            } else {
              await expect(svc.get(r.id, SALES)).rejects.toMatchObject({
                status: 403,
              });
              const err = await svc.get(r.id, SALES).catch((e: unknown) => e);
              expect(err).toBeInstanceOf(AppError);
              expect((err as AppError).status).toBe(403);

              await expect(svc.export(r.id, SALES)).rejects.toMatchObject({ status: 403 });
            }
          }

          // 3. ADMIN can read every report regardless of status.
          for (const r of rows) {
            const view = await svc.get(r.id, ADMIN);
            expect(view.id).toBe(r.id);
            expect(view.status).toBe(r.status);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
