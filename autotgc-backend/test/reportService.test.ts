/**
 * Unit / edge tests for ReportService
 * (ai-reporting-and-ops-enhancements, Req 2.1, 2.3, 3.1, 3.4, 3.5, 5.4).
 *
 * Prisma is replaced by a small in-memory fake covering only the model methods
 * the service calls. The Gemini seam is a stub that can succeed or throw on
 * demand. No mocking of the system under test — the real ReportService,
 * reportEngine, reportStateMachine, and reportExport run end to end.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { ReportService } from '../src/reporting/reportService';
import type { CompanyReportView } from '../src/reporting/reportService';
import type { ReportPeriod, ReportScope, ReportType } from '../src/reporting/types';
import type { ContentGenerator } from '../src/strategy/personaService';
import type { AuthInfo } from '../src/http/authMiddleware';

// --- in-memory Prisma fake ---------------------------------------------------

interface AnyRow {
  [k: string]: unknown;
}

interface FakeDb {
  companyReports: AnyRow[];
  performanceRecords: AnyRow[];
  leads: AnyRow[];
  candidates: AnyRow[];
  auditEntries: AnyRow[];
  prisma: PrismaClient;
}

function inWindow(t: Date, w?: { gte?: Date; lt?: Date }): boolean {
  if (!w) return true;
  const ms = t.getTime();
  if (w.gte && ms < w.gte.getTime()) return false;
  if (w.lt && ms >= w.lt.getTime()) return false;
  return true;
}

function makeFakeDb(): FakeDb {
  const companyReports: AnyRow[] = [];
  const performanceRecords: AnyRow[] = [];
  const leads: AnyRow[] = [];
  const candidates: AnyRow[] = [];
  const auditEntries: AnyRow[] = [];
  let seq = 0;
  const id = (p: string): string => `${p}_${++seq}`;

  const matchReport = (r: AnyRow, where?: AnyRow): boolean => {
    if (!where) return true;
    if (where.reportType !== undefined && r.reportType !== where.reportType) return false;
    if (where.status !== undefined && r.status !== where.status) return false;
    return true;
  };

  const prisma = {
    companyReport: {
      create: async (args: { data: AnyRow }) => {
        const now = new Date();
        const row = { id: id('rep'), createdAt: now, updatedAt: now, ...args.data };
        companyReports.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        companyReports.find((r) => r.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: AnyRow }) => {
        const row = companyReports.find((r) => r.id === args.where.id);
        if (!row) throw new Error('companyReport not found');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      },
      findMany: async (args?: { where?: AnyRow }) =>
        companyReports.filter((r) => matchReport(r, args?.where)),
      count: async (args?: { where?: AnyRow }) =>
        companyReports.filter((r) => matchReport(r, args?.where)).length,
    },
    performanceRecord: {
      findMany: async (args?: { where?: { scoredAt?: { gte?: Date; lt?: Date } } }) =>
        performanceRecords.filter((r) => inWindow(r.scoredAt as Date, args?.where?.scoredAt)),
    },
    lead: {
      findMany: async (args?: { where?: { createdAt?: { gte?: Date; lt?: Date } } }) =>
        leads.filter((r) => inWindow(r.createdAt as Date, args?.where?.createdAt)),
    },
    candidateProfile: {
      findMany: async (args?: { where?: { createdAt?: { gte?: Date; lt?: Date } } }) =>
        candidates.filter((r) => inWindow(r.createdAt as Date, args?.where?.createdAt)),
    },
    auditEntry: {
      create: async (args: { data: AnyRow }) => {
        const row = { id: id('ae'), recordedAt: new Date(), ...args.data };
        auditEntries.push(row);
        return row;
      },
    },
  } as unknown as PrismaClient;

  return { companyReports, performanceRecords, leads, candidates, auditEntries, prisma };
}

function geminiStub(opts: { fail?: boolean; text?: string } = {}): ContentGenerator {
  return {
    generateContent: async () => {
      if (opts.fail) throw new Error('gemini down');
      return opts.text ?? 'Tóm tắt điều hành do AI tạo.';
    },
  };
}

const WEEK: ReportPeriod = {
  label: '2024-W23',
  from: new Date('2024-06-03T00:00:00.000Z'),
  to: new Date('2024-06-10T00:00:00.000Z'),
};
const MONTH: ReportPeriod = {
  label: '2024-06',
  from: new Date('2024-06-01T00:00:00.000Z'),
  to: new Date('2024-07-01T00:00:00.000Z'),
};

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 's1' };
const ADMIN_SCOPE: ReportScope = { role: 'ADMIN', userId: 'admin-1' };

function seedPerformance(db: FakeDb, at: Date): void {
  db.performanceRecords.push({
    id: `p_${db.performanceRecords.length}`,
    performanceLabel: 'AVERAGE_PERFORMER',
    conversionRate: 3,
    engagementRate: 5,
    ctaClickRate: 2,
    scoredAt: at,
  });
}

function seedLead(db: FakeDb, at: Date, assignedTo: string | null = null): void {
  db.leads.push({
    leadId: `l_${db.leads.length}`,
    source: 'facebook',
    assignedTo,
    createdAt: at,
  });
}

describe('ReportService — generate & lifecycle', () => {
  it('creates a WEEKLY report in DRAFT with deterministic summary when no Gemini (Req 2.1, 3.1, 2.4)', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    seedLead(db, new Date('2024-06-05T10:00:00.000Z'));
    const svc = new ReportService(db.prisma);

    const view = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);

    expect(view.reportType).toBe('WEEKLY');
    expect(view.status).toBe('DRAFT');
    expect(view.aiGenerated).toBe(false);
    expect(view.content.executiveSummary.length).toBeGreaterThan(0);
    expect(db.companyReports).toHaveLength(1);
  });

  it('supports MONTHLY reportType (Req 2.1)', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-15T10:00:00.000Z'));
    const svc = new ReportService(db.prisma);

    const view = await svc.generateForPeriod('MONTHLY', MONTH, ADMIN_SCOPE);
    expect(view.reportType).toBe('MONTHLY');
    expect(view.status).toBe('DRAFT');
  });

  it('uses Gemini for the executive summary and flags aiGenerated=true (Req 2.3)', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    const svc = new ReportService(db.prisma, geminiStub({ text: 'Bản tóm tắt AI.' }));

    const view = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    expect(view.aiGenerated).toBe(true);
    expect(view.content.executiveSummary).toBe('Bản tóm tắt AI.');
  });

  it('falls back to deterministic summary when Gemini fails (Req 2.4)', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    const svc = new ReportService(db.prisma, geminiStub({ fail: true }));

    const view = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    expect(view.aiGenerated).toBe(false);
    expect(view.content.executiveSummary.length).toBeGreaterThan(0);
  });

  it('creates an INSUFFICIENT_DATA report with no recommendations when no rows (Req 2.5)', async () => {
    const db = makeFakeDb();
    const svc = new ReportService(db.prisma, geminiStub({ text: 'should not be used' }));

    const view = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    expect(view.status).toBe('INSUFFICIENT_DATA');
    expect(view.aiGenerated).toBe(false);
    expect(view.content.recommendations).toEqual([]);
  });

  it('writes an Audit_Log entry when a report transitions to APPROVED (Req 3.5)', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    const svc = new ReportService(db.prisma);

    const created = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    await svc.transition(created.id, 'IN_REVIEW', ADMIN);
    const approved = await svc.transition(created.id, 'APPROVED', ADMIN);

    expect(approved.status).toBe('APPROVED');
    expect(db.auditEntries).toHaveLength(1);
    const entry = db.auditEntries[0];
    expect(entry.eventType).toBe('REPORT_APPROVED');
    expect(entry.insightId).toBe(created.id);
    expect(entry.actor).toBe(ADMIN.userId);
    expect(entry.recordedAt).toBeInstanceOf(Date);
  });

  it('rejects an illegal status transition with 409 (Req 3.3)', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    const svc = new ReportService(db.prisma);

    const created = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    // DRAFT -> APPROVED is not a valid step.
    await expect(svc.transition(created.id, 'APPROVED', ADMIN)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('ReportService — updateContent editability (Req 3.4)', () => {
  async function createInStatus(
    db: FakeDb,
    svc: ReportService,
    status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ARCHIVED',
  ): Promise<CompanyReportView> {
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    const created = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    if (status === 'DRAFT') return created;
    await svc.transition(created.id, 'IN_REVIEW', ADMIN);
    if (status === 'IN_REVIEW') return svc.get(created.id, ADMIN);
    if (status === 'APPROVED') {
      await svc.transition(created.id, 'APPROVED', ADMIN);
      return svc.get(created.id, ADMIN);
    }
    // ARCHIVED: from IN_REVIEW
    await svc.transition(created.id, 'ARCHIVED', ADMIN);
    return svc.get(created.id, ADMIN);
  }

  it('allows editing a DRAFT report', async () => {
    const db = makeFakeDb();
    const svc = new ReportService(db.prisma);
    const draft = await createInStatus(db, svc, 'DRAFT');

    const updated = await svc.updateContent(draft.id, { highlights: ['Điểm nổi bật mới'] }, ADMIN);
    expect(updated.content.highlights).toEqual(['Điểm nổi bật mới']);
  });

  it('allows editing an IN_REVIEW report', async () => {
    const db = makeFakeDb();
    const svc = new ReportService(db.prisma);
    const inReview = await createInStatus(db, svc, 'IN_REVIEW');

    const updated = await svc.updateContent(inReview.id, { highlights: ['Sửa khi review'] }, ADMIN);
    expect(updated.content.highlights).toEqual(['Sửa khi review']);
  });

  it('rejects editing an APPROVED report with 409', async () => {
    const db = makeFakeDb();
    const svc = new ReportService(db.prisma);
    const approved = await createInStatus(db, svc, 'APPROVED');

    await expect(
      svc.updateContent(approved.id, { highlights: ['x'] }, ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects editing an ARCHIVED report with 409', async () => {
    const db = makeFakeDb();
    const svc = new ReportService(db.prisma);
    const archived = await createInStatus(db, svc, 'ARCHIVED');

    await expect(
      svc.updateContent(archived.id, { highlights: ['x'] }, ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('ReportService — export (Req 5.4)', () => {
  it('exports an APPROVED report as downloadable markdown', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    const svc = new ReportService(db.prisma);

    const created = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    await svc.transition(created.id, 'IN_REVIEW', ADMIN);
    await svc.transition(created.id, 'APPROVED', ADMIN);

    const out = await svc.export(created.id, ADMIN);
    expect(out.filename).toMatch(/\.md$/);
    expect(out.contentType).toContain('text/markdown');
    expect(out.body.length).toBeGreaterThan(0);
  });

  it('rejects exporting a non-APPROVED (DRAFT) report with 409', async () => {
    const db = makeFakeDb();
    seedPerformance(db, new Date('2024-06-04T10:00:00.000Z'));
    const svc = new ReportService(db.prisma);

    const created = await svc.generateForPeriod('WEEKLY', WEEK, ADMIN_SCOPE);
    await expect(svc.export(created.id, ADMIN)).rejects.toMatchObject({ status: 409 });
  });
});
