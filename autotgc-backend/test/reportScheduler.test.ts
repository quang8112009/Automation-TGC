/**
 * Integration / smoke + unit tests for the Report_Scheduler
 * (ai-reporting-and-ops-enhancements, Req 4.1, 4.2, 4.3, 4.4).
 *
 * Two seams are exercised without mocking the system under test:
 *  - A recording fake `Scheduler` captures `schedule(name, cron, fn)` calls so
 *    we can assert exactly TWO jobs are registered with the env-driven cron
 *    (default + overridden via a real `SecretLoader`) (Req 4.1), and that
 *    invoking a job calls `generateForPeriod` with the PREVIOUS period and the
 *    ADMIN/background-worker scope (Req 4.2, 4.4).
 *  - The REAL `ReportService` over a tiny in-memory Prisma fake verifies a
 *    scheduled run persists a `DRAFT` (never auto-APPROVED) (Req 4.2, 4.4).
 *  - The REAL `NodeCronScheduler` (with node-cron) verifies a job whose
 *    ReportService throws does NOT propagate — the error is caught + logged
 *    with the job name and a timestamp, and sibling jobs/process survive
 *    (Req 4.3).
 *
 * The pure period helpers `previousWeekPeriod` / `previousMonthPeriod` are
 * unit- and property-tested for a correct half-open `[from, to)` UTC window.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { getTasks } from 'node-cron';
import type { PrismaClient } from '@prisma/client';

import { NodeCronScheduler } from '../src/infra/scheduler';
import type { JobFn, Scheduler, SchedulerLogger } from '../src/infra/scheduler';
import {
  registerReportJobs,
  previousWeekPeriod,
  previousMonthPeriod,
  REPORT_CRON_DEFAULTS,
  BACKGROUND_WORKER_USER_ID,
} from '../src/reporting/reportScheduler';
import type { ReportGenerator } from '../src/reporting/reportScheduler';
import type { ReportPeriod, ReportScope, ReportType } from '../src/reporting/types';
import { createSecretLoader } from '../src/infra/secrets';
import { ReportService } from '../src/reporting/reportService';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- recording fakes ---------------------------------------------------------

interface RecordedJob {
  name: string;
  cron: string;
  fn: JobFn;
}

/** Scheduler that only records schedule() calls (no node-cron). */
class RecordingScheduler implements Scheduler {
  readonly jobs: RecordedJob[] = [];
  schedule(name: string, cron: string, fn: JobFn): void {
    this.jobs.push({ name, cron, fn });
  }
  start(): void {
    /* no-op */
  }
  stop(): void {
    /* no-op */
  }
  job(name: string): RecordedJob {
    const found = this.jobs.find((j) => j.name === name);
    if (!found) throw new Error(`no job registered named ${name}`);
    return found;
  }
}

interface GenerateCall {
  type: ReportType;
  period: ReportPeriod;
  scope: ReportScope;
}

/** ReportGenerator that records its calls and returns a dummy view. */
class RecordingGenerator implements ReportGenerator {
  readonly calls: GenerateCall[] = [];
  async generateForPeriod(
    type: ReportType,
    period: ReportPeriod,
    scope: ReportScope,
  ): Promise<unknown> {
    this.calls.push({ type, period, scope });
    return { id: 'rep_fake' };
  }
}

/** ReportGenerator that always throws (to exercise the scheduler's catch+log). */
class ThrowingGenerator implements ReportGenerator {
  constructor(private readonly message = 'report generation failed') {}
  async generateForPeriod(): Promise<unknown> {
    throw new Error(this.message);
  }
}

/** Captures the scheduler's structured error logs. */
function makeCapturingLogger(): {
  logger: SchedulerLogger;
  errors: Array<{ obj: unknown; msg?: string }>;
} {
  const errors: Array<{ obj: unknown; msg?: string }> = [];
  const logger: SchedulerLogger = {
    info: () => {
      /* ignore info noise */
    },
    error: (obj: unknown, msg?: string) => {
      errors.push({ obj, msg });
    },
  };
  return { logger, errors };
}

// --- tiny in-memory Prisma fake (only what generateForPeriod touches) --------

interface AnyRow {
  [k: string]: unknown;
}

function inWindow(t: Date, w?: { gte?: Date; lt?: Date }): boolean {
  if (!w) return true;
  const ms = t.getTime();
  if (w.gte && ms < w.gte.getTime()) return false;
  if (w.lt && ms >= w.lt.getTime()) return false;
  return true;
}

interface FakeDb {
  companyReports: AnyRow[];
  performanceRecords: AnyRow[];
  prisma: PrismaClient;
}

function makeFakeDb(): FakeDb {
  const companyReports: AnyRow[] = [];
  const performanceRecords: AnyRow[] = [];
  let seq = 0;

  const prisma = {
    companyReport: {
      create: async (args: { data: AnyRow }) => {
        const now = new Date();
        const row = { id: `rep_${++seq}`, createdAt: now, updatedAt: now, ...args.data };
        companyReports.push(row);
        return row;
      },
    },
    performanceRecord: {
      findMany: async (args?: { where?: { scoredAt?: { gte?: Date; lt?: Date } } }) =>
        performanceRecords.filter((r) => inWindow(r.scoredAt as Date, args?.where?.scoredAt)),
    },
    lead: {
      findMany: async () => [],
    },
    candidateProfile: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient;

  return { companyReports, performanceRecords, prisma };
}

// --- cleanup: destroy any node-cron tasks created by the integration tests ---

afterEach(async () => {
  for (const task of getTasks().values()) {
    await task.destroy();
  }
});

// =============================================================================
// Pure period helpers — correct half-open [from, to) UTC window
// =============================================================================

describe('previousWeekPeriod', () => {
  it('returns the previous full ISO week as [Mon 00:00 UTC, next Mon 00:00 UTC) (Req 4.1, 4.2)', () => {
    // Wednesday 2024-06-12 -> current week starts Mon 2024-06-10; previous week
    // is [2024-06-03, 2024-06-10), labeled "2024-W23".
    const period = previousWeekPeriod(new Date('2024-06-12T10:30:00.000Z'));
    expect(period.from.toISOString()).toBe('2024-06-03T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2024-06-10T00:00:00.000Z');
    expect(period.label).toBe('2024-W23');
  });

  it('treats Monday as the start of the current week (previous week ends today)', () => {
    const period = previousWeekPeriod(new Date('2024-06-10T00:00:00.000Z'));
    expect(period.from.toISOString()).toBe('2024-06-03T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2024-06-10T00:00:00.000Z');
  });

  it('handles Sunday correctly (ISO week ends on Sunday)', () => {
    // Sunday 2024-06-09 is in the week starting Mon 2024-06-03; previous full
    // week is [2024-05-27, 2024-06-03).
    const period = previousWeekPeriod(new Date('2024-06-09T23:59:59.000Z'));
    expect(period.from.toISOString()).toBe('2024-05-27T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2024-06-03T00:00:00.000Z');
  });

  it('property: window is exactly 7 days, UTC-midnight aligned, half-open and strictly before now', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') }), (now) => {
        const { from, to } = previousWeekPeriod(now);
        // exactly 7 days
        expect(to.getTime() - from.getTime()).toBe(7 * MS_PER_DAY);
        // both aligned to UTC midnight on a Monday
        for (const d of [from, to]) {
          expect(d.getUTCHours()).toBe(0);
          expect(d.getUTCMinutes()).toBe(0);
          expect(d.getUTCSeconds()).toBe(0);
          expect(d.getUTCMilliseconds()).toBe(0);
          expect(d.getUTCDay()).toBe(1); // Monday
        }
        // half-open and entirely in the past: now is NOT before `to`
        expect(from.getTime()).toBeLessThan(to.getTime());
        expect(to.getTime()).toBeLessThanOrEqual(now.getTime());
      }),
      { numRuns: 200 },
    );
  });
});

describe('previousMonthPeriod', () => {
  it('returns the previous full calendar month as [1st 00:00 UTC, next 1st 00:00 UTC) (Req 4.1, 4.2)', () => {
    const period = previousMonthPeriod(new Date('2024-06-12T10:30:00.000Z'));
    expect(period.from.toISOString()).toBe('2024-05-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(period.label).toBe('2024-05');
  });

  it('rolls over the year at January (previous month is December of prior year)', () => {
    const period = previousMonthPeriod(new Date('2025-01-15T08:00:00.000Z'));
    expect(period.from.toISOString()).toBe('2024-12-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(period.label).toBe('2024-12');
  });

  it('property: from is the 1st of the month preceding `to`, both UTC-midnight, half-open, strictly before now', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') }), (now) => {
        const { from, to } = previousMonthPeriod(now);
        for (const d of [from, to]) {
          expect(d.getUTCDate()).toBe(1);
          expect(d.getUTCHours()).toBe(0);
          expect(d.getUTCMinutes()).toBe(0);
          expect(d.getUTCSeconds()).toBe(0);
          expect(d.getUTCMilliseconds()).toBe(0);
        }
        expect(from.getTime()).toBeLessThan(to.getTime());
        // `to` is the first of the month containing `now`, so it is <= now.
        expect(to.getTime()).toBeLessThanOrEqual(now.getTime());
        // from + 1 month === to
        const expectedTo = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
        expect(to.getTime()).toBe(expectedTo.getTime());
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// registerReportJobs — registration (Req 4.1)
// =============================================================================

describe('registerReportJobs — registration', () => {
  it('registers exactly two jobs with the default crons when env is unset (Req 4.1)', () => {
    const scheduler = new RecordingScheduler();
    registerReportJobs(scheduler, {
      reportService: new RecordingGenerator(),
      secrets: createSecretLoader({}),
    });

    expect(scheduler.jobs).toHaveLength(2);
    expect(scheduler.jobs.map((j) => j.name)).toEqual([
      'weekly-company-report',
      'monthly-company-report',
    ]);
    expect(scheduler.job('weekly-company-report').cron).toBe(REPORT_CRON_DEFAULTS.weekly);
    expect(scheduler.job('monthly-company-report').cron).toBe(REPORT_CRON_DEFAULTS.monthly);
  });

  it('uses the env-overridden cron expressions when provided (Req 4.1)', () => {
    const scheduler = new RecordingScheduler();
    registerReportJobs(scheduler, {
      reportService: new RecordingGenerator(),
      secrets: createSecretLoader({
        CRON_WEEKLY_REPORT: '15 3 * * 1',
        CRON_MONTHLY_REPORT: '30 4 2 * *',
      }),
    });

    expect(scheduler.job('weekly-company-report').cron).toBe('15 3 * * 1');
    expect(scheduler.job('monthly-company-report').cron).toBe('30 4 2 * *');
  });
});

// =============================================================================
// registerReportJobs — job behavior (Req 4.2, 4.4)
// =============================================================================

describe('registerReportJobs — job invocation', () => {
  const NOW = new Date('2024-06-12T10:30:00.000Z');

  it('weekly job calls generateForPeriod with the previous week and ADMIN/background-worker scope (Req 4.2, 4.4)', async () => {
    const scheduler = new RecordingScheduler();
    const gen = new RecordingGenerator();
    registerReportJobs(scheduler, {
      reportService: gen,
      secrets: createSecretLoader({}),
      now: () => NOW,
    });

    await scheduler.job('weekly-company-report').fn();

    expect(gen.calls).toHaveLength(1);
    const call = gen.calls[0];
    expect(call.type).toBe('WEEKLY');
    expect(call.period).toEqual(previousWeekPeriod(NOW));
    expect(call.scope).toEqual({ role: 'ADMIN', userId: BACKGROUND_WORKER_USER_ID });
  });

  it('monthly job calls generateForPeriod with the previous month and ADMIN/background-worker scope (Req 4.2, 4.4)', async () => {
    const scheduler = new RecordingScheduler();
    const gen = new RecordingGenerator();
    registerReportJobs(scheduler, {
      reportService: gen,
      secrets: createSecretLoader({}),
      now: () => NOW,
    });

    await scheduler.job('monthly-company-report').fn();

    expect(gen.calls).toHaveLength(1);
    const call = gen.calls[0];
    expect(call.type).toBe('MONTHLY');
    expect(call.period).toEqual(previousMonthPeriod(NOW));
    expect(call.scope).toEqual({ role: 'ADMIN', userId: BACKGROUND_WORKER_USER_ID });
  });

  it('persists a DRAFT report (never auto-APPROVED) via the real ReportService (Req 4.2, 4.4)', async () => {
    const db = makeFakeDb();
    // A performance row inside the previous week so the report is not empty.
    db.performanceRecords.push({
      id: 'p1',
      performanceLabel: 'AVERAGE_PERFORMER',
      conversionRate: 3,
      engagementRate: 5,
      ctaClickRate: 2,
      scoredAt: new Date('2024-06-04T10:00:00.000Z'),
    });

    const scheduler = new RecordingScheduler();
    registerReportJobs(scheduler, {
      reportService: new ReportService(db.prisma),
      secrets: createSecretLoader({}),
      now: () => NOW,
    });

    await scheduler.job('weekly-company-report').fn();

    expect(db.companyReports).toHaveLength(1);
    const report = db.companyReports[0];
    expect(report.status).toBe('DRAFT');
    expect(report.status).not.toBe('APPROVED');
    expect(report.reportType).toBe('WEEKLY');
    expect(report.createdBy).toBe(BACKGROUND_WORKER_USER_ID);
    expect(report.scopeUserId).toBeNull();
    expect(report.aiGenerated).toBe(false);
  });
});

// =============================================================================
// Fail-safe: errors are caught + logged by the real NodeCronScheduler (Req 4.3)
// =============================================================================

describe('registerReportJobs — fail-safe through NodeCronScheduler (Req 4.3)', () => {
  /** Find the node-cron task registered under a given job name. */
  function taskByName(name: string) {
    for (const task of getTasks().values()) {
      if (task.name === name) return task;
    }
    throw new Error(`no node-cron task named ${name}`);
  }

  it('a job whose ReportService throws does not propagate; the error is caught + logged with the job name and timestamp', async () => {
    const { logger, errors } = makeCapturingLogger();
    const scheduler = new NodeCronScheduler(logger);
    registerReportJobs(scheduler, {
      reportService: new ThrowingGenerator('weekly boom'),
      secrets: createSecretLoader({}),
      now: () => new Date('2024-06-12T10:30:00.000Z'),
    });

    const weekly = taskByName('weekly-company-report');

    // Running the wrapped job must NOT reject — the scheduler swallows it.
    await expect(weekly.execute()).resolves.not.toThrow();

    // The failure was logged with the job name + a failure timestamp (Req 4.3).
    expect(errors).toHaveLength(1);
    const entry = errors[0].obj as { job?: string; failedAt?: string; error?: string };
    expect(entry.job).toBe('weekly-company-report');
    expect(typeof entry.failedAt).toBe('string');
    expect(Number.isNaN(Date.parse(entry.failedAt as string))).toBe(false);
    expect(entry.error).toContain('weekly boom');
  });

  it('a failing job does not crash sibling jobs (the monthly job still runs)', async () => {
    const { logger, errors } = makeCapturingLogger();
    const scheduler = new NodeCronScheduler(logger);
    // Generator throws only for WEEKLY; MONTHLY succeeds.
    const gen: ReportGenerator = {
      generateForPeriod: async (type: ReportType): Promise<unknown> => {
        if (type === 'WEEKLY') throw new Error('weekly boom');
        return { id: 'ok' };
      },
    };
    registerReportJobs(scheduler, {
      reportService: gen,
      secrets: createSecretLoader({}),
      now: () => new Date('2024-06-12T10:30:00.000Z'),
    });

    await expect(taskByName('weekly-company-report').execute()).resolves.not.toThrow();
    await expect(taskByName('monthly-company-report').execute()).resolves.not.toThrow();

    // Only the weekly run logged an error; the monthly run completed cleanly.
    expect(errors).toHaveLength(1);
    expect((errors[0].obj as { job?: string }).job).toBe('weekly-company-report');
  });
});
