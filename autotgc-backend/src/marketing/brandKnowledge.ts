/**
 * Brand-knowledge grounding seam for the AI marketing autopilot (customer:
 * Thanh Giang Conincon — Vietnamese labor-export / XKLĐ).
 *
 * WHY: the recruitment-consultant agent already grounds its prompts in the
 * curated KNOWLEDGE_BASE (company / market / visa / industry / process / faq /
 * branch). The marketing GENERATORS (multi-format content, trend research,
 * content planning) historically did NOT — so their AI output could drift
 * off-brand. This module exposes a tiny, dependency-light seam the generators
 * can OPTIONALLY consume to PREPEND a deterministic, factual grounding block to
 * their prompts, mirroring `consultantAgent.buildSystemPrompt`'s grounding style.
 *
 * HONESTY / GROUNDING NOTE: this is RETRIEVAL grounding, not a trained model. It
 * pulls relevant `KnowledgeEntry` rows via `KnowledgeService` and renders them as
 * a plain-text block. It contains only public company facts + curated knowledge;
 * it NEVER embeds secrets/API keys. Grounding must NEVER break generation: any
 * error (e.g. a DB hiccup) degrades gracefully to just the company-identity line.
 *
 * The block shape (Vietnamese, deterministic for a given DB state + opts):
 *   [CongTy] <company-identity line>
 *   [TriThuc] Tri thức nền liên quan:
 *   - <title>: <content (≤ ~240 ký tự)>
 *   - ...
 */
import type { KnowledgeEntry } from '@prisma/client';
import type { KnowledgeService } from '../recruitment/knowledge/knowledgeService';
import { COMPANY_IDENTITY } from '../recruitment/knowledge/knowledgeBase';
import { MARKET_LABELS, marketLabel } from './markets';
import type { Market } from './markets';

/** Options that bias which knowledge is retrieved for a grounding block. */
export interface GroundingOptions {
  /** Target market code (e.g. JAPAN); pulls market-specific entries when set. */
  market?: string;
  /** Free-text topic the content is about. */
  topic?: string;
  /** Primary keyword the content targets. */
  keyword?: string;
  /** Content format code (e.g. SEO_ARTICLE) — used only to bias the search. */
  format?: string;
  /** Max curated entries to include (default 6). */
  limit?: number;
}

/** The grounding seam the marketing generators optionally depend on. */
export interface BrandKnowledgeProvider {
  /**
   * Build a Vietnamese grounding block: always a `[CongTy]` company-identity
   * line, optionally followed by a `[TriThuc]` block of the most relevant
   * curated entries. Never throws.
   */
  groundingBlock(opts: GroundingOptions): Promise<string>;
}

/** Default number of curated entries rendered into a grounding block. */
export const DEFAULT_GROUNDING_LIMIT = 6;

/** Per-entry content is trimmed to this many characters to keep prompts tight. */
export const MAX_ENTRY_CONTENT_CHARS = 240;

/** The markets named in the company-identity line (Thanh Giang's target set). */
const IDENTITY_MARKETS: readonly Market[] = [
  'JAPAN',
  'KOREA',
  'GERMANY',
  'TAIWAN',
  'AUSTRALIA',
  'LITHUANIA',
  'EUROPE',
];

/**
 * Pure, deterministic `[CongTy]` company-identity line, assembled from the
 * public `COMPANY_IDENTITY` facts. Names Thanh Giang, the XKLĐ business, the
 * target markets, and the on-brand content principles (uy tín, kéo lead). No
 * secrets.
 */
export function companyIdentityLine(): string {
  const markets = IDENTITY_MARKETS.map((m) => MARKET_LABELS[m]).join(', ');
  return (
    `[CongTy] ${COMPANY_IDENTITY.name} — công ty xuất khẩu lao động (XKLĐ), ` +
    `thành lập ${COMPANY_IDENTITY.founded}, trụ sở ${COMPANY_IDENTITY.hq}, ${COMPANY_IDENTITY.branchesNote}. ` +
    `Các thị trường: ${markets}. ` +
    `Nguyên tắc nội dung: uy tín, trung thực, không bịa chi phí/điều kiện, ` +
    `bám sát tri thức công ty và tối ưu để thu hút người xem và kéo lead.`
  );
}

/** Trim an entry's content to `max` chars (adds an ellipsis when truncated). */
function trimContent(content: string, max = MAX_ENTRY_CONTENT_CHARS): string {
  const c = (content ?? '').trim();
  if (c.length <= max) return c;
  return `${c.slice(0, max).trimEnd()}…`;
}

/**
 * PURE helper (DB-free, unit-testable): render the final grounding block from a
 * pre-computed identity line + the retrieved entries. Always STARTS with the
 * identity line; includes AT MOST `limit` entries, each as a `- <title>:
 * <content>` line with content trimmed to ~240 chars. When no entries are
 * supplied it returns just the identity line.
 *
 * Deterministic: depends only on its inputs. Never invents content, never
 * embeds secrets.
 */
export function composeGroundingBlock(
  identityLine: string,
  entries: ReadonlyArray<{ title: string; content: string }>,
  limit: number = DEFAULT_GROUNDING_LIMIT,
): string {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_GROUNDING_LIMIT;
  const capped = entries.slice(0, n);
  if (capped.length === 0) {
    return identityLine;
  }
  const lines = capped.map((e) => `- ${e.title}: ${trimContent(e.content)}`);
  return [identityLine, '[TriThuc] Tri thức nền liên quan:', ...lines].join('\n');
}

/** Stable de-dup key for a knowledge row (id when present, else category+title). */
function entryKey(entry: KnowledgeEntry): string {
  if (entry.id && entry.id.trim().length > 0) return `id:${entry.id}`;
  return `kt:${entry.category}|${entry.title}`;
}

/**
 * `KnowledgeService`-backed grounding provider. Combines a relevance search with
 * the always-relevant `company` entries and (when a market is given) that
 * market's entries, de-dupes, caps at `limit`, and renders the block.
 */
export class KnowledgeBrandProvider implements BrandKnowledgeProvider {
  constructor(private readonly knowledge: KnowledgeService) {}

  async groundingBlock(opts: GroundingOptions = {}): Promise<string> {
    const identityLine = companyIdentityLine();
    try {
      const limit =
        Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0
          ? Math.floor(opts.limit as number)
          : DEFAULT_GROUNDING_LIMIT;

      const market = typeof opts.market === 'string' ? opts.market.trim() : '';
      const label = market.length > 0 ? marketLabel(market) : '';
      const query = [label, opts.topic, opts.keyword, opts.format]
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter((p) => p.length > 0)
        .join(' ')
        .trim();

      // Retrieve in a deterministic, fixed order: relevance search → company
      // identity entries → market entries. De-dup preserves first occurrence.
      const searched = query.length > 0 ? await this.knowledge.search(query, limit) : [];
      const company = await this.knowledge.list('company');
      const marketEntries = market.length > 0 ? await this.knowledge.list('market', market) : [];

      const seen = new Set<string>();
      const combined: KnowledgeEntry[] = [];
      for (const entry of [...searched, ...company, ...marketEntries]) {
        const key = entryKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        combined.push(entry);
      }

      const capped = combined
        .slice(0, limit)
        .map((e) => ({ title: e.title, content: e.content }));
      return composeGroundingBlock(identityLine, capped, limit);
    } catch {
      // Grounding must NEVER break generation — degrade to the identity line.
      return identityLine;
    }
  }
}
