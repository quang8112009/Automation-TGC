/**
 * KnowledgeService — manages the grounded knowledge base used by the AI
 * recruitment-consultant agent (customer: Thanh Giang Conincon).
 *
 * Responsibilities:
 *  - seed(): idempotent upsert of the curated KNOWLEDGE_BASE by the stable key
 *    `category + title` (safe to run repeatedly; never duplicates rows).
 *  - list(category?, market?): read active entries with optional filters.
 *  - search(query): case-insensitive keyword/tag ranking over title+content+tags.
 *  - create / update / deactivate: ADMIN management of entries.
 *
 * The ranking logic (`scoreEntry`, `rankEntries`) is PURE and exported so it can
 * be unit/property tested without a database. There are no AI calls here — this
 * is retrieval grounding, not model training.
 */
import type { KnowledgeEntry, PrismaClient, Prisma } from '@prisma/client';
import { KNOWLEDGE_BASE } from './knowledgeBase';
import type { KnowledgeSeed } from './knowledgeBase';

/** Default number of ranked results returned by search(). */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Minimal entry shape the pure ranking helpers operate on. */
export interface RankableEntry {
  title: string;
  content: string;
  tags: string[];
  market?: string | null;
}

/** Coerce a Prisma `Json` tags column into a string[] (defensive). */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

/** Split a free-text query into lowercased, non-empty tokens. */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Pure relevance score of one entry against a query. Higher is more relevant.
 * Deterministic: depends only on the entry and the query.
 *
 * Scoring (per query token):
 *  - exact tag match: +5
 *  - token appears in title: +3
 *  - token appears in content: +1
 * Plus a small +2 bonus when the whole (trimmed) query phrase appears in title.
 */
export function scoreEntry(entry: RankableEntry, query: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  const title = entry.title.toLowerCase();
  const content = entry.content.toLowerCase();
  const tags = entry.tags.map((t) => t.toLowerCase());

  let score = 0;
  for (const token of tokens) {
    if (tags.includes(token)) score += 5;
    if (title.includes(token)) score += 3;
    if (content.includes(token)) score += 1;
  }

  const phrase = query.trim().toLowerCase();
  if (phrase.length > 0 && title.includes(phrase)) score += 2;

  return score;
}

/**
 * Pure ranking: returns the top-N entries with score > 0, ordered by descending
 * score then by title (stable, deterministic tie-break). Entries that match
 * nothing are excluded.
 */
export function rankEntries<T extends RankableEntry>(
  entries: readonly T[],
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): T[] {
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((s) => s.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.title.localeCompare(b.entry.title);
  });

  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SEARCH_LIMIT;
  return scored.slice(0, n).map((s) => s.entry);
}

/** Convert a stored KnowledgeEntry row into the pure RankableEntry shape. */
export function toRankable(entry: KnowledgeEntry): RankableEntry {
  return {
    title: entry.title,
    content: entry.content,
    tags: normalizeTags(entry.tags),
    market: entry.market,
  };
}

/**
 * Pure ranking over stored KnowledgeEntry rows: scores each row with
 * `scoreEntry`, keeps positives, and returns the top-N (descending score, then
 * title for a stable tie-break). Exported for direct unit testing.
 */
export function rankRows(
  rows: readonly KnowledgeEntry[],
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): KnowledgeEntry[] {
  const scored = rows
    .map((row) => ({ row, score: scoreEntry(toRankable(row), query) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.row.title.localeCompare(b.row.title);
  });
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SEARCH_LIMIT;
  return scored.slice(0, n).map((s) => s.row);
}

export interface KnowledgeInput {
  category: string;
  title: string;
  content: string;
  tags?: string[];
  market?: string | null;
  active?: boolean;
}

export class KnowledgeService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Idempotently seed the curated KNOWLEDGE_BASE. Uses (category, title) as a
   * stable natural key: existing rows are updated in place, missing rows are
   * created. Returns counts so the seed script can log a summary.
   */
  async seed(entries: readonly KnowledgeSeed[] = KNOWLEDGE_BASE): Promise<{
    created: number;
    updated: number;
    total: number;
  }> {
    let created = 0;
    let updated = 0;

    for (const entry of entries) {
      const existing = await this.prisma.knowledgeEntry.findFirst({
        where: { category: entry.category, title: entry.title },
        select: { id: true },
      });

      const data = {
        category: entry.category,
        title: entry.title,
        content: entry.content,
        tags: entry.tags as unknown as Prisma.InputJsonValue,
        market: entry.market ?? null,
        active: true,
      };

      if (existing) {
        await this.prisma.knowledgeEntry.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await this.prisma.knowledgeEntry.create({ data });
        created += 1;
      }
    }

    return { created, updated, total: entries.length };
  }

  /** List active entries, optionally filtered by category and/or market. */
  async list(category?: string, market?: string): Promise<KnowledgeEntry[]> {
    const where: Prisma.KnowledgeEntryWhereInput = { active: true };
    if (category && category.trim().length > 0) where.category = category.trim();
    if (market && market.trim().length > 0) where.market = market.trim();
    return this.prisma.knowledgeEntry.findMany({
      where,
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
    });
  }

  /**
   * Keyword/tag search over active entries. Loads active rows and ranks them
   * with the pure `rankEntries` helper, returning the top-N most relevant.
   */
  async search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Promise<KnowledgeEntry[]> {
    if (!query || query.trim().length === 0) return [];
    const active = await this.prisma.knowledgeEntry.findMany({ where: { active: true } });
    return rankRows(active, query, limit);
  }

  /** Create a new knowledge entry (ADMIN management). */
  async create(input: KnowledgeInput): Promise<KnowledgeEntry> {
    return this.prisma.knowledgeEntry.create({
      data: {
        category: input.category,
        title: input.title,
        content: input.content,
        tags: (input.tags ?? []) as unknown as Prisma.InputJsonValue,
        market: input.market ?? null,
        active: input.active ?? true,
      },
    });
  }

  /** Update an existing entry by id (ADMIN management). */
  async update(id: string, input: Partial<KnowledgeInput>): Promise<KnowledgeEntry> {
    const data: Prisma.KnowledgeEntryUpdateInput = {};
    if (input.category !== undefined) data.category = input.category;
    if (input.title !== undefined) data.title = input.title;
    if (input.content !== undefined) data.content = input.content;
    if (input.tags !== undefined) data.tags = input.tags as unknown as Prisma.InputJsonValue;
    if (input.market !== undefined) data.market = input.market;
    if (input.active !== undefined) data.active = input.active;
    return this.prisma.knowledgeEntry.update({ where: { id }, data });
  }

  /** Soft-delete: mark an entry inactive so it is excluded from grounding. */
  async deactivate(id: string): Promise<KnowledgeEntry> {
    return this.prisma.knowledgeEntry.update({ where: { id }, data: { active: false } });
  }

  /**
   * Persist a freshly-computed embedding vector for an entry (semantic-retrieval
   * cache). Stored as a `Json` number[]; reading code normalizes it defensively.
   */
  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.prisma.knowledgeEntry.update({
      where: { id },
      data: { embedding: embedding as unknown as Prisma.InputJsonValue },
    });
  }
}
