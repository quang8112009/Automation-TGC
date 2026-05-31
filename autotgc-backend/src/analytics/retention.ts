/**
 * Retention predicate (design Req 5.1, 5.2 / Property 6).
 *
 * Pure, framework-free. An `Analytics_Record` or `Performance_Record` stays
 * available for Pattern_Recognition exactly while its age is at or within the
 * configurable Retention_Period (default 12 months) — INCLUSIVE of the exact
 * boundary. The clock is injected by the caller (`now`) so retention is
 * deterministic and testable.
 */

/** Default Retention_Period in months (design Req 5.1). */
export const DEFAULT_RETENTION_MONTHS = 12;

/** A record (or bare timestamp) whose retention is being evaluated. */
export type RetainableRecord =
  | Date
  | string
  | { collectedAt?: Date | string | null; scoredAt?: Date | string | null };

/** Extract the record's reference timestamp (collectedAt or scoredAt). */
function recordTime(record: RetainableRecord): number {
  if (record instanceof Date) return record.getTime();
  if (typeof record === 'string') return new Date(record).getTime();
  const raw = record.collectedAt ?? record.scoredAt ?? null;
  if (raw === null) return Number.NaN;
  return raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
}

/**
 * The inclusive lower-bound timestamp: records at or after this instant are
 * retained. Computed by subtracting `months` calendar months from `now`.
 */
export function retentionCutoff(now: Date, months: number = DEFAULT_RETENTION_MONTHS): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

/**
 * True iff the record is at or within the Retention_Period relative to `now`,
 * inclusive of the exact boundary instant (Req 5.1, 5.2).
 */
export function isRetained(
  record: RetainableRecord,
  now: Date,
  months: number = DEFAULT_RETENTION_MONTHS,
): boolean {
  const t = recordTime(record);
  if (!Number.isFinite(t)) return false;
  return t >= retentionCutoff(now, months).getTime();
}
