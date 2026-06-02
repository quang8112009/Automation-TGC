/**
 * Unit / edge tests for DocumentChecklistService (Requirements 11.3, 12.2,
 * 12.3, 13.1, 13.2, 13.3, 13.4).
 *
 * Uses an in-memory Prisma fake that backs the two tables the service touches:
 *  - `candidateProfile.findUnique` (id + desiredMarket lookup), and
 *  - `documentChecklistItem` create/findMany/findUnique/update.
 *
 * The fake mirrors the relevant slice of Prisma's runtime behavior the service
 * depends on: `create` accepts either the scalar `candidateId` form (used by
 * `initForCandidate`) or the relational `candidate: { connect: { id } }` form
 * (used by `addCustom`); `findMany` filters by `candidateId`/`source` and
 * orders by `createdAt asc`. Created rows get monotonically increasing
 * `createdAt` values so ordering is deterministic.
 *
 * The catalog-update-doesn't-touch-checklist case (Req 12.5) is already covered
 * in `documentCatalogService.test.ts`; this file focuses on the CHECKLIST
 * service.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../src/http/authMiddleware';
import { DocumentChecklistService } from '../src/recruitment/documents/documentChecklistService';
import { defaultDocsForMarket } from '../src/recruitment/documents/documentCatalog';
import { ValidationError } from '../src/infra/errors';

/** A document-checklist row as stored by the in-memory fake. */
interface ChecklistRow {
  id: string;
  candidateId: string;
  type: string;
  label: string;
  required: boolean;
  source: string;
  status: string;
  note: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CandidateRow {
  id: string;
  desiredMarket: string | null;
}

/**
 * Build an in-memory Prisma fake seeded with the given candidate rows. Checklist
 * items live in an id-keyed map; `created` exposes the live store so tests can
 * assert against persisted rows.
 */
function fakePrisma(candidates: CandidateRow[]): {
  prisma: PrismaClient;
  items: Map<string, ChecklistRow>;
} {
  const candidateMap = new Map<string, CandidateRow>();
  for (const c of candidates) candidateMap.set(c.id, { ...c });

  const items = new Map<string, ChecklistRow>();
  let seq = 0;
  const nextSeq = () => (seq += 1);

  /** Resolve the candidate id from either the scalar or relational create form. */
  const resolveCandidateId = (data: Record<string, unknown>): string => {
    if (typeof data.candidateId === 'string') return data.candidateId;
    const rel = data.candidate as { connect?: { id?: string } } | undefined;
    if (rel?.connect?.id) return rel.connect.id;
    throw new Error('fake: create missing candidate id');
  };

  const prisma = {
    candidateProfile: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = candidateMap.get(args.where.id);
        return row ? { id: row.id, desiredMarket: row.desiredMarket } : null;
      },
    },
    documentChecklistItem: {
      create: async (args: { data: Record<string, unknown> }) => {
        const data = args.data;
        const n = nextSeq();
        const candidateId = resolveCandidateId(data);
        const now = new Date(Date.UTC(2024, 0, 1) + n * 1000);
        const row: ChecklistRow = {
          id: `doc-${n}`,
          candidateId,
          type: String(data.type),
          label: String(data.label),
          required: data.required === undefined ? true : Boolean(data.required),
          source: String(data.source ?? 'DEFAULT'),
          status: String(data.status ?? 'PENDING'),
          note: (data.note as string | undefined) ?? null,
          submittedAt: (data.submittedAt as Date | undefined) ?? null,
          createdAt: now,
          updatedAt: now,
        };
        items.set(row.id, row);
        return { ...row };
      },
      findMany: async (args: {
        where: { candidateId: string; source?: string };
        orderBy?: { createdAt?: 'asc' | 'desc' };
      }) => {
        const { candidateId, source } = args.where;
        const matched = [...items.values()].filter(
          (r) => r.candidateId === candidateId && (source === undefined || r.source === source),
        );
        matched.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return matched.map((r) => ({ ...r }));
      },
      findUnique: async (args: { where: { id: string } }) => {
        const row = items.get(args.where.id);
        return row ? { ...row } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = items.get(args.where.id);
        if (!row) throw new Error('fake: update of missing row');
        if (args.data.status !== undefined) row.status = String(args.data.status);
        if (args.data.submittedAt !== undefined) row.submittedAt = args.data.submittedAt as Date;
        row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
        return { ...row };
      },
    },
  } as unknown as PrismaClient;

  return { prisma, items };
}

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-1' };

describe('DocumentChecklistService.initForCandidate', () => {
  it('seeds items from the market default set for a candidate.desiredMarket (Req 12.2)', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-jp', desiredMarket: 'JAPAN' }]);
    const service = new DocumentChecklistService(prisma);

    const created = await service.initForCandidate('cand-jp', ADMIN);
    const expected = defaultDocsForMarket('JAPAN');

    expect(created).toHaveLength(expected.length);
    // Seeded items mirror the catalog (type/label/required) in catalog order.
    expect(created.map((i) => ({ type: i.type, label: i.label, required: i.required }))).toEqual(
      expected,
    );
    // Every seeded item is a DEFAULT/PENDING item bound to the candidate.
    expect(created.every((i) => i.source === 'DEFAULT')).toBe(true);
    expect(created.every((i) => i.status === 'PENDING')).toBe(true);
    expect(created.every((i) => i.candidateId === 'cand-jp')).toBe(true);
  });

  it('falls back to the OTHER set when desiredMarket is null (Req 12.3)', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-x', desiredMarket: null }]);
    const service = new DocumentChecklistService(prisma);

    const created = await service.initForCandidate('cand-x', ADMIN);

    expect(created.map((i) => ({ type: i.type, label: i.label, required: i.required }))).toEqual(
      defaultDocsForMarket('OTHER'),
    );
  });

  it('is idempotent: calling twice does not duplicate items (Req 12.2)', async () => {
    const { prisma, items } = fakePrisma([{ id: 'cand-jp', desiredMarket: 'JAPAN' }]);
    const service = new DocumentChecklistService(prisma);

    const first = await service.initForCandidate('cand-jp', ADMIN);
    const second = await service.initForCandidate('cand-jp', ADMIN);

    // The guard returns the already-seeded rows rather than creating more.
    expect(second).toHaveLength(first.length);
    expect(items.size).toBe(first.length);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });
});

describe('DocumentChecklistService.addCustom', () => {
  it('creates an item with source CUSTOM (Req 13.1)', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-1', desiredMarket: 'KOREA' }]);
    const service = new DocumentChecklistService(prisma);

    const item = await service.addCustom('cand-1', { label: '  Giấy xác nhận  ' }, ADMIN);

    expect(item.source).toBe('CUSTOM');
    expect(item.candidateId).toBe('cand-1');
    expect(item.label).toBe('Giấy xác nhận'); // trimmed
    expect(item.required).toBe(true); // default
    expect(item.status).toBe('PENDING');
  });

  it('honors an explicit required flag', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-1', desiredMarket: 'KOREA' }]);
    const service = new DocumentChecklistService(prisma);

    const item = await service.addCustom('cand-1', { label: 'Optional doc', required: false }, ADMIN);

    expect(item.required).toBe(false);
  });

  it('rejects a blank/whitespace label with a 400 ValidationError (Req 13.2)', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-1', desiredMarket: 'KOREA' }]);
    const service = new DocumentChecklistService(prisma);

    for (const label of ['', '   ', '\t\n']) {
      const err = await service.addCustom('cand-1', { label }, ADMIN).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(400);
    }
  });
});

describe('DocumentChecklistService.updateStatus', () => {
  it('records submittedAt when transitioning to SUBMITTED (Req 13.3)', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-1', desiredMarket: 'JAPAN' }]);
    const service = new DocumentChecklistService(prisma);
    const [first] = await service.initForCandidate('cand-1', ADMIN);

    const before = Date.now();
    const updated = await service.updateStatus(first.id, 'SUBMITTED', ADMIN);

    expect(updated.status).toBe('SUBMITTED');
    expect(updated.submittedAt).toBeInstanceOf(Date);
    expect((updated.submittedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not stamp submittedAt for non-SUBMITTED statuses', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-1', desiredMarket: 'JAPAN' }]);
    const service = new DocumentChecklistService(prisma);
    const [first] = await service.initForCandidate('cand-1', ADMIN);

    const updated = await service.updateStatus(first.id, 'VERIFIED', ADMIN);

    expect(updated.status).toBe('VERIFIED');
    expect(updated.submittedAt).toBeNull();
  });

  it('rejects a status outside the four-value enum with a 400 ValidationError (Req 11.3)', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-1', desiredMarket: 'JAPAN' }]);
    const service = new DocumentChecklistService(prisma);
    const [first] = await service.initForCandidate('cand-1', ADMIN);

    for (const bad of ['APPROVED', 'pending', '', 42, null]) {
      const err = await service.updateStatus(first.id, bad, ADMIN).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(400);
    }
  });
});

describe('DocumentChecklistService.list', () => {
  it('returns items together with the completion metric (Req 13.4)', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-1', desiredMarket: 'JAPAN' }]);
    const service = new DocumentChecklistService(prisma);
    const seeded = await service.initForCandidate('cand-1', ADMIN);

    // No required items VERIFIED yet → completion is 0 (denominator > 0).
    const before = await service.list('cand-1', ADMIN);
    expect(before.items).toHaveLength(seeded.length);
    expect(before.completion).toBe(0);

    // Verify every required item → completion becomes 1.
    for (const item of before.items.filter((i) => i.required)) {
      await service.updateStatus(item.id, 'VERIFIED', ADMIN);
    }
    const after = await service.list('cand-1', ADMIN);
    expect(after.completion).toBe(1);
  });

  it('reports INSUFFICIENT_DATA when there are no required items', async () => {
    const { prisma } = fakePrisma([{ id: 'cand-empty', desiredMarket: 'JAPAN' }]);
    const service = new DocumentChecklistService(prisma);

    // Only an optional custom item, no required items at all.
    await service.addCustom('cand-empty', { label: 'Optional only', required: false }, ADMIN);

    const result = await service.list('cand-empty', ADMIN);
    expect(result.items).toHaveLength(1);
    expect(result.completion).toBe('INSUFFICIENT_DATA');
  });
});
