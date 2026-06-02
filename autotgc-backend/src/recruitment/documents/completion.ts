/**
 * Document checklist completion metric (Requirements 13.4, 13.5).
 *
 * Pure, framework-free logic with divide-by-zero safety, mirroring the
 * `INSUFFICIENT_DATA` pattern used in `analytics/scoring.ts`. Surfaces
 * `'INSUFFICIENT_DATA'` instead of performing a division when there are no
 * required items, so the metric is never `NaN`/`Infinity` and always lands in
 * the closed interval [0, 1] when numeric.
 *
 * NOTE: `documentCatalog.ts` (which is intended to export `DocSubmissionStatus`)
 * is being created in parallel and does not yet exist on disk. To avoid an
 * import-timing failure, a local string-union `DocSubmissionStatus` is defined
 * here matching the design's enum. Once `./documentCatalog` exists and exports
 * the type, this can be switched to a re-export without changing the contract.
 */

export type DocSubmissionStatus = 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

export interface ChecklistItemLike {
  required: boolean;
  status: DocSubmissionStatus;
}

/**
 * Completion ratio = (number of required items with status VERIFIED) /
 * (total number of required items).
 *
 * - Total required === 0 → `'INSUFFICIENT_DATA'` (no division performed).
 * - Otherwise the result is always in the closed interval [0, 1] and is never
 *   `NaN` or `Infinity` (the numerator is a subset count of the denominator).
 *
 * (Requirements 13.4, 13.5)
 */
export function completionMetric(
  items: readonly ChecklistItemLike[],
): number | 'INSUFFICIENT_DATA' {
  let totalRequired = 0;
  let verifiedRequired = 0;

  for (const item of items) {
    if (!item.required) continue;
    totalRequired += 1;
    if (item.status === 'VERIFIED') verifiedRequired += 1;
  }

  if (totalRequired === 0) return 'INSUFFICIENT_DATA';

  return verifiedRequired / totalRequired;
}
