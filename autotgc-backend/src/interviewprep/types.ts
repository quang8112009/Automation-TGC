/**
 * Interview prep — shared types.
 *
 * Framework-free domain types for the visa-interview practice capability. Kept
 * free of Prisma/Fastify concerns so the pure question-bank and scorer modules
 * can be property-tested directly.
 */

/**
 * A single visa-interview practice question.
 *
 * - `code` — stable, deterministic identifier for the question (used as a dedup
 *   key and for storing answers against the question).
 * - `prompt` — the question text shown to the candidate (product language is
 *   Vietnamese, with English visa terms preserved where natural).
 * - `category` — coarse grouping (e.g. study plan, finance, intent, documents)
 *   used for organising the session UI.
 */
export interface InterviewQuestion {
  code: string;
  prompt: string;
  category: string;
}
