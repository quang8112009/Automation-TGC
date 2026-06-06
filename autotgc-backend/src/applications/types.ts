/**
 * Applications & timeline — shared types (study-abroad-ai-advisor-suite).
 *
 * Framework-free projections (no Prisma/Fastify) used by the pure
 * `Timeline_Computer` core so it can be property-tested directly. A `DueItem`
 * is a single deadline-bearing task (`VisaTask` / application milestone) that
 * belongs to an `ApplicationCase` or `VisaCase`.
 *
 * _Requirements: 14.1, 14.3, 14.5_
 */

/**
 * A single deadline-bearing item belonging to one `ApplicationCase` or
 * `VisaCase`. `dueAt === null` represents an as-yet-undetermined deadline (no
 * fabricated date — Req 13.4) and is ordered after all dated items (Req 14.5).
 */
export interface DueItem {
  /** Stable unique identifier of the due item. */
  id: string;
  /** Identifier of the owning `ApplicationCase` / `VisaCase`. */
  caseId: string;
  /** Whether the owning case is a program application or a visa case. */
  caseType: 'APPLICATION' | 'VISA';
  /** Deterministic catalog code (e.g. `I-20`, `CAS`), used as a tie-break key. */
  code: string;
  /** Human-readable label for display. */
  label: string;
  /** Deadline, or `null` when the deadline is not yet determined. */
  dueAt: Date | null;
  /** Whether the item has already been completed. */
  done: boolean;
}
