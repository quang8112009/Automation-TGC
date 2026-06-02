/**
 * DocumentCatalogService — ADMIN-configurable per-market default document set
 * over the `DocumentTypeCatalog` model (Requirements 12.4, 12.5).
 *
 * I/O wrapper around the pure default catalog in `documentCatalog.ts`:
 *  - `get(market)` returns the persisted `DocTypeDef[]` for a market, falling
 *    back to the built-in defaults (`defaultDocsForMarket`) when no catalog row
 *    has been configured yet, so unconfigured markets still return sensible
 *    defaults. (Req 12.4)
 *  - `update(market, docs)` upserts the catalog row for a market. It writes ONLY
 *    the catalog table and NEVER touches `DocumentChecklistItem` rows, so editing
 *    the catalog leaves existing candidates' checklists unchanged. (Req 12.5)
 *
 * RBAC (ADMIN-only) and route wiring are enforced at the route layer (task 7.8),
 * not here. Market codes are validated against the canonical `RecruitmentMarket`
 * set; invalid codes and malformed `docs` entries raise `ValidationError` (400).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { ValidationError } from '../../infra/errors';
import { blank, isRecruitmentMarket } from '../validation';
import { defaultDocsForMarket } from './documentCatalog';
import type { DocTypeDef } from './documentCatalog';

export class DocumentCatalogService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Return the configured default document set for `market`. When no
   * `DocumentTypeCatalog` row exists yet, fall back to the built-in defaults
   * (`defaultDocsForMarket`) so unconfigured-but-valid markets still resolve.
   * (Req 12.4)
   */
  async get(market: string): Promise<DocTypeDef[]> {
    const code = this.normalizeMarket(market);
    const row = await this.prisma.documentTypeCatalog.findUnique({ where: { market: code } });
    if (!row) {
      return defaultDocsForMarket(code);
    }
    return parseDocs(row.docs);
  }

  /**
   * Upsert the `DocumentTypeCatalog` row for `market` with a validated/normalized
   * copy of `docs`. CRITICAL: this writes ONLY the catalog table; it never reads
   * or mutates any `DocumentChecklistItem`, so already-created candidate
   * checklists are left untouched. (Req 12.5)
   */
  async update(market: string, docs: DocTypeDef[]): Promise<DocTypeDef[]> {
    const code = this.normalizeMarket(market);
    const normalized = normalizeDocs(docs);
    const json = normalized as unknown as Prisma.InputJsonValue;

    await this.prisma.documentTypeCatalog.upsert({
      where: { market: code },
      create: { market: code, docs: json },
      update: { docs: json },
    });

    return normalized;
  }

  /** Validate and return a canonical `RecruitmentMarket` code, else 400. */
  private normalizeMarket(market: string): string {
    if (!isRecruitmentMarket(market)) {
      throw new ValidationError(`Invalid market: ${String(market)}`, 'INVALID_MARKET');
    }
    return market;
  }
}

/**
 * Validate + normalize an incoming `DocTypeDef[]`:
 *  - `docs` must be an array;
 *  - each entry must have a non-blank `type` and non-blank `label` (trimmed);
 *  - `required` is coerced to a boolean (defaulting to `true` when absent).
 * Invalid input raises `ValidationError` (400).
 */
function normalizeDocs(docs: unknown): DocTypeDef[] {
  if (!Array.isArray(docs)) {
    throw new ValidationError('docs must be an array', 'INVALID_DOCS');
  }
  return docs.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new ValidationError(`docs[${i}] must be an object`, 'INVALID_DOC_ENTRY');
    }
    const entry = raw as Record<string, unknown>;
    const type = typeof entry.type === 'string' ? entry.type.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (blank(type)) {
      throw new ValidationError(`docs[${i}].type must not be blank`, 'INVALID_DOC_TYPE');
    }
    if (blank(label)) {
      throw new ValidationError(`docs[${i}].label must not be blank`, 'INVALID_DOC_LABEL');
    }
    return { type, label, required: entry.required === undefined ? true : Boolean(entry.required) };
  });
}

/**
 * Narrow a persisted `Json` value into `DocTypeDef[]`. Stored rows are written
 * via `normalizeDocs`, so this defensively re-normalizes and drops any malformed
 * entries rather than throwing on read.
 */
function parseDocs(value: unknown): DocTypeDef[] {
  if (!Array.isArray(value)) return [];
  const out: DocTypeDef[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const type = typeof entry.type === 'string' ? entry.type.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (blank(type) || blank(label)) continue;
    out.push({ type, label, required: entry.required === undefined ? true : Boolean(entry.required) });
  }
  return out;
}
