/**
 * knowledgeSearchTool — a reusable, READ-ONLY tool that lets the grounded
 * assistant retrieve KnowledgeBase entries on demand during an agent loop.
 *
 * This is the first concrete tool wired into the harness. It is safe by design:
 *  - read-only (delegates to `KnowledgeService.search`, no writes);
 *  - validated arguments (query must be a non-empty string; optional bounded
 *    limit) — invalid args are rejected by the registry as TOOL_BAD_ARGUMENTS;
 *  - returns a compact, secret-free projection (title/category/snippet), capped
 *    so a tool result can never blow up the next prompt.
 *
 * `buildKnowledgeSearchTool` returns a `ToolDefinition` to register in a
 * `ToolRegistry`, and `KNOWLEDGE_SEARCH_TOOL_SCHEMA` is the matching JSON-schema
 * the `AiTextChatCompleter` offers to the model. Any domain can reuse both.
 */
import type { ToolDefinition } from './aiToolCalls';
import type { ToolSchema } from './aiChatCompleter';

/** Narrowed arguments for the knowledge-search tool. */
export interface KnowledgeSearchArgs {
  query: string;
  /** Optional result cap; clamped to [1,10]. */
  limit?: number;
}

/** A compact, secret-free knowledge hit returned to the model. */
export interface KnowledgeSearchHit {
  title: string;
  category: string;
  /** Content snippet, truncated to keep tool output bounded. */
  snippet: string;
}

/** The minimal search seam the tool needs (KnowledgeService satisfies it). */
export interface KnowledgeSearchPort {
  search(
    query: string,
    limit?: number,
  ): Promise<ReadonlyArray<{ title: string; category: string; content: string }>>;
}

/** Max characters of an entry's content included in a hit snippet. */
const SNIPPET_MAX = 280;
/** Max hits returned regardless of the requested limit. */
const HITS_CEILING = 10;

/** Pure validator: query must be a non-empty string; limit optional in [1,10]. */
export function validateKnowledgeSearchArgs(args: Record<string, unknown>): KnowledgeSearchArgs | undefined {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) return undefined;

  let limit: number | undefined;
  if (args.limit !== undefined) {
    const n = Number(args.limit);
    if (!Number.isFinite(n)) return undefined;
    const floored = Math.floor(n);
    limit = floored < 1 ? 1 : floored > HITS_CEILING ? HITS_CEILING : floored;
  }
  return { query: query.trim(), limit };
}

/** Pure projection: map search rows to compact, bounded, secret-free hits. */
export function projectHits(
  rows: ReadonlyArray<{ title: string; category: string; content: string }>,
): KnowledgeSearchHit[] {
  return rows.slice(0, HITS_CEILING).map((r) => ({
    title: r.title,
    category: r.category,
    snippet: r.content.length > SNIPPET_MAX ? `${r.content.slice(0, SNIPPET_MAX)}…` : r.content,
  }));
}

/** JSON-schema offered to the model for this tool. */
export const KNOWLEDGE_SEARCH_TOOL_SCHEMA: ToolSchema = {
  name: 'knowledge_search',
  description:
    'Tìm kiếm trong kho tri thức nội bộ (KnowledgeBase) để lấy thông tin nền có căn cứ. ' +
    'Dùng khi cần dữ kiện cụ thể về chương trình, quốc gia, visa, quy trình. Chỉ đọc.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Cụm từ khóa cần tra cứu.' },
      limit: { type: 'integer', minimum: 1, maximum: HITS_CEILING, description: 'Số kết quả tối đa (mặc định 5).' },
    },
    required: ['query'],
  },
};

/**
 * Build the read-only knowledge-search `ToolDefinition` to register in a
 * `ToolRegistry`. The handler delegates to the injected search port and returns
 * compact hits; it never writes and never returns secrets.
 */
export function buildKnowledgeSearchTool(port: KnowledgeSearchPort): ToolDefinition<KnowledgeSearchArgs> {
  return {
    name: 'knowledge_search',
    validate: validateKnowledgeSearchArgs,
    async handler(args: KnowledgeSearchArgs): Promise<{ hits: KnowledgeSearchHit[] }> {
      const rows = await port.search(args.query, args.limit);
      return { hits: projectHits(rows) };
    },
  };
}
