/**
 * KnowledgeRetriever — hybrid (keyword + semantic) grounding retrieval over the
 * KnowledgeBase, with the SAME AI-OPTIONAL guarantee as the rest of the system.
 *
 * Without an `Embedder` (or when the embedding provider is unavailable / a query
 * cannot be embedded), it delegates verbatim to the existing deterministic
 * keyword search (`KnowledgeService.search`) — so behaviour is unchanged by
 * default and nothing breaks when AI is unconfigured. With an embedder it blends
 * the keyword score and the cosine similarity of each active entry's cached
 * embedding (`hybridRank`), surfacing semantically-related entries keyword search
 * would miss (synonyms, paraphrase), while still honouring exact keyword hits.
 *
 * `reindex` (ADMIN-triggered) computes and persists embeddings for active
 * entries; it is best-effort and never throws — entries that fail to embed are
 * counted as skipped and simply rank by keyword until a later reindex.
 */
import type { KnowledgeEntry } from '@prisma/client';
import type { Embedder } from '../../infra/embeddingClient';
import { cosineSimilarity, hybridRank, normalizeEmbedding } from '../../infra/semanticRanking';
import type { HybridCandidate } from '../../infra/semanticRanking';
import { KnowledgeService, scoreEntry, toRankable, DEFAULT_SEARCH_LIMIT } from './knowledgeService';

export interface ReindexResult {
  /** Entries whose embedding was (re)computed and persisted. */
  updated: number;
  /** Active entries skipped because the embedder returned nothing. */
  skipped: number;
}

export class KnowledgeRetriever {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly embedder?: Embedder,
  ) {}

  /**
   * Retrieve the top-N grounding entries for a query. Keyword-only when no
   * embedder is configured or the query cannot be embedded; otherwise a hybrid
   * keyword+semantic ranking over active entries that carry an embedding.
   */
  async retrieve(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Promise<KnowledgeEntry[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    // No embedder → deterministic keyword path (unchanged behaviour).
    if (!this.embedder) {
      return this.knowledge.search(query, limit);
    }

    const queryVector = await this.embedder.embed(query);
    // Embedding unavailable for this query → keyword fallback.
    if (!queryVector) {
      return this.knowledge.search(query, limit);
    }

    const rows = await this.knowledge.list(); // active only
    const candidates: HybridCandidate<KnowledgeEntry>[] = rows.map((row) => {
      const vector = normalizeEmbedding(row.embedding);
      const similarity = vector ? cosineSimilarity(queryVector, vector) : 0;
      const keywordScore = scoreEntry(toRankable(row), query);
      return { item: row, keywordScore, similarity };
    });

    // Keep only entries with ANY signal (a positive keyword hit or a positive
    // semantic similarity); rank the rest by the blended score.
    const signaled = candidates.filter((c) => c.keywordScore > 0 || c.similarity > 0);
    if (signaled.length === 0) return [];
    return hybridRank(signaled, limit);
  }

  /**
   * Recompute and persist embeddings for all active entries. Best-effort and
   * non-throwing: an entry that cannot be embedded is left as-is (ranks by
   * keyword) and counted as skipped. Returns counts for the caller to report.
   */
  async reindex(): Promise<ReindexResult> {
    if (!this.embedder) return { updated: 0, skipped: 0 };
    const rows = await this.knowledge.list();
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const vector = await this.embedder.embed(`${row.title}\n${row.content}`);
      if (vector) {
        await this.knowledge.setEmbedding(row.id, vector);
        updated += 1;
      } else {
        skipped += 1;
      }
    }
    return { updated, skipped };
  }
}
