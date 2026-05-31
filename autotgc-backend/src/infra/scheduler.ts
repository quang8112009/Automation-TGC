/**
 * Scheduler — thin wrapper over node-cron (Foundation Req 17.x).
 *
 * Registers named cron jobs, starts/stops them, and guarantees that a thrown
 * job error is caught and logged with the job name and a failure timestamp so a
 * single failing run never crashes the process or other jobs.
 */
import { schedule } from 'node-cron';
import type { ScheduledTask } from 'node-cron';

/** Minimal logger surface (compatible with pino). */
export interface SchedulerLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export type JobFn = () => void | Promise<void>;

export interface Scheduler {
  schedule(name: string, cronExpr: string, fn: JobFn): void;
  start(): void;
  stop(): void;
}

/** node-cron-backed scheduler. Tasks are created stopped and started via start(). */
export class NodeCronScheduler implements Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly logger: SchedulerLogger) {}

  schedule(name: string, cronExpr: string, fn: JobFn): void {
    const wrapped = async (): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        // Req 17.3: catch + log job errors with job name + timestamp.
        const message = err instanceof Error ? err.message : 'unknown error';
        this.logger.error(
          { job: name, failedAt: new Date().toISOString(), error: message },
          `Scheduled job "${name}" failed`,
        );
      }
    };

    const task = schedule(cronExpr, wrapped, { name });
    this.tasks.set(name, task);
    this.logger.info({ job: name, cron: cronExpr }, `Registered scheduled job "${name}"`);
  }

  start(): void {
    for (const [name, task] of this.tasks) {
      void task.start();
      this.logger.info({ job: name }, `Started scheduled job "${name}"`);
    }
  }

  stop(): void {
    for (const [name, task] of this.tasks) {
      void task.stop();
      this.logger.info({ job: name }, `Stopped scheduled job "${name}"`);
    }
  }
}
