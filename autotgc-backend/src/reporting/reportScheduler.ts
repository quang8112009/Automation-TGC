/**
 * Report_Scheduler — registers the periodic company-report jobs
 * (ai-reporting-and-ops-enhancements, Req 4.1, 4.2, 4.4).
 *
 * Mirrors the `infra/jobs.ts` registration pattern: cron expressions are read
 * from optional secrets with sensible defaults, and each job is registered on
 * the passed `Scheduler` (a `NodeCronScheduler` in production). The scheduler
 * already catches + logs job errors with the job name and a failure timestamp
 * and never crashes the process or sibling jobs (Req 4.3), so the job bodies
 * here deliberately do NOT swallow errors — a thrown error propagates to the
 * scheduler's wrapper.
 *
 * Each job computes the PREVIOUS full period (the week/month that just ended) as
 * a half-open `[from, to)` window in UTC via the pure, deterministic helpers
 * `previousWeekPeriod` / `previousMonthPeriod` (exported for unit testing), then
 * generates a report under an ADMIN/background-worker scope. ReportService
 * always persists the new report in `DRAFT` (review mode) — it is never
 * auto-APPROVED (Req 4.2, 4.4).
 */
import type { Scheduler } from '../infra/scheduler';
import type { SecretLoader } from '../infra/secrets';
import type { ReportPeriod, ReportScope, ReportType } from './types';

/** Default cron expressions (env-overridable). */
export const REPORT_CRON_DEFAULTS = {
  /** Mondays at 01:00 — report for the week that just ended. */
  weekly: '0 1 * * 1',
  /** 1st of the month at 02:00 — report for the month that just ended. */
  monthly: '0 2 1 * *',
} as const;

/** The synthetic actor recorded as `createdBy` for scheduler-generated reports. */
export const BACKGROUND_WORKER_USER_ID = 'background-worker';

/** Scope used for every scheduled report: company-wide (ADMIN), no SALES filter. */
const BACKGROUND_SCOPE: ReportScope = { role: 'ADMIN', userId: BACKGROUND_WORKER_USER_ID };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The report generator seam the scheduler needs. `ReportService` satisfies this
 * structurally, so production wiring passes the real service while tests can
 * pass a recording fake without casting.
 */
export interface ReportGenerator {
  generateForPeriod(type: ReportType, period: ReportPeriod, scope: ReportScope): Promise<unknown>;
}

/** Dependencies for registering the report jobs. */
export interface ReportSchedulerDeps {
  reportService: ReportGenerator;
  secrets: SecretLoader;
  /**
   * Clock used to compute "now" at job-run time. Defaults to the system clock.
   * The period helpers stay pure (they take `now` explicitly) so this is the
   * only non-deterministic seam, and it is overridable for deterministic tests.
   */
  now?: () => Date;
}

/** Start of the ISO week (Monday 00:00 UTC) containing `date`. */
function startOfIsoWeekUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weekday: Mon=1 .. Sun=7.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (isoDay - 1));
  return d;
}

/**
 * ISO-8601 week-numbering parts (year + week) for a UTC date. The ISO year is
 * the year of the Thursday in the same week, so it can differ from the calendar
 * year near year boundaries.
 */
function isoWeekParts(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Shift to the Thursday of this week; the ISO year is that Thursday's year.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
  return { year: isoYear, week };
}

/**
 * PURE: the previous full ISO week relative to `now`, as a half-open UTC window
 * `[from, to)`. `to` is the Monday 00:00 UTC that starts the week containing
 * `now`; `from` is the Monday seven days earlier. The label is the ISO
 * week-numbering label of the period, e.g. `"2024-W23"`. (Req 4.1, 4.2)
 */
export function previousWeekPeriod(now: Date): ReportPeriod {
  const to = startOfIsoWeekUtc(now);
  const from = new Date(to.getTime() - 7 * MS_PER_DAY);
  const { year, week } = isoWeekParts(from);
  return {
    label: `${year}-W${String(week).padStart(2, '0')}`,
    from,
    to,
  };
}

/**
 * PURE: the previous full calendar month relative to `now`, as a half-open UTC
 * window `[from, to)`. `to` is the first day 00:00 UTC of the month containing
 * `now`; `from` is the first day of the preceding month. The label is the
 * period's calendar month, e.g. `"2024-06"`. (Req 4.1, 4.2)
 */
export function previousMonthPeriod(now: Date): ReportPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const to = new Date(Date.UTC(year, month, 1));
  // Date.UTC normalizes month === -1 to December of the previous year.
  const from = new Date(Date.UTC(year, month - 1, 1));
  const label = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
  return { label, from, to };
}

/**
 * Register the WEEKLY and MONTHLY company-report jobs on the scheduler.
 *
 * - `weekly-company-report`  — cron `CRON_WEEKLY_REPORT`  (default `0 1 * * 1`).
 * - `monthly-company-report` — cron `CRON_MONTHLY_REPORT` (default `0 2 1 * *`).
 *
 * Each job computes the previous full period and generates a `DRAFT` report
 * under the background ADMIN scope. Errors are intentionally NOT caught here;
 * the scheduler logs + isolates them (Req 4.3).
 */
export function registerReportJobs(scheduler: Scheduler, deps: ReportSchedulerDeps): void {
  const { reportService, secrets } = deps;
  const now = deps.now ?? ((): Date => new Date());

  const weeklyCron = secrets.optional('CRON_WEEKLY_REPORT') ?? REPORT_CRON_DEFAULTS.weekly;
  const monthlyCron = secrets.optional('CRON_MONTHLY_REPORT') ?? REPORT_CRON_DEFAULTS.monthly;

  scheduler.schedule('weekly-company-report', weeklyCron, async () => {
    const period = previousWeekPeriod(now());
    await reportService.generateForPeriod('WEEKLY', period, BACKGROUND_SCOPE);
  });

  scheduler.schedule('monthly-company-report', monthlyCron, async () => {
    const period = previousMonthPeriod(now());
    await reportService.generateForPeriod('MONTHLY', period, BACKGROUND_SCOPE);
  });
}
