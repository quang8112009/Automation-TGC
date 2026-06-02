/**
 * Unit tests for DocumentCatalogService (Requirements 12.4, 12.5).
 *
 * Uses an in-memory Prisma fake that tracks calls to BOTH the
 * `documentTypeCatalog` table (the only table the service should write) and the
 * `documentChecklistItem` table (which the service must NEVER touch). The fake
 * counts every method invocation on the checklist table so the tests can assert
 * that updating the catalog leaves already-created checklist items untouched.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DocumentCatalogService } from '../src/recruitment/documents/documentCatalogService';
import {
  DEFAULT_DOC_CATALOG,
  defaultDocsForMarket,
} from '../src/recruitment/documents/documentCatalog';
import type { DocTypeDef } from '../src/recruitment/documents/documentCatalog';
import { ValidationError } from '../src/infra/errors';

interface CatalogRow {
  id: string;
  market: string;
  docs: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Build an in-memory Prisma fake. `catalog` is a market->row map; every call to
 * any `documentChecklistItem` method increments `checklistCalls` so tests can
 * assert the checklist table was never read or written.
 */
function fakePrisma(seed: CatalogRow[] = []): {
  prisma: PrismaClient;
  catalog: Map<string, CatalogRow>;
  checklistCalls: { count: number; methods: string[] };
} {
  const catalog = new Map<string, CatalogRow>();
  for (const row of seed) catalog.set(row.market, { ...row });

  const checklistCalls = { count: 0, methods: [] as string[] };
  const trackChecklist = (method: string) => async (..._args: unknown[]) => {
    checklistCalls.count += 1;
    checklistCalls.methods.push(method);
    return method === 'findMany' ? [] : null;
  };

  const prisma = {
    documentTypeCatalog: {
      findUnique: async (args: { where: { market: string } }) =>
        catalog.get(args.where.market) ?? null,
      upsert: async (args: {
        where: { market: string };
        create: { market: string; docs: unknown };
        update: { docs: unknown };
      }) => {
        const existing = catalog.get(args.where.market);
        if (existing) {
          existing.docs = args.update.docs;
          existing.updatedAt = new Date();
          return existing;
        }
        const row: CatalogRow = {
          id: `cat-${catalog.size + 1}`,
          market: args.create.market,
          docs: args.create.docs,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        catalog.set(row.market, row);
        return row;
      },
    },
    // The service must NEVER call into this table. Every method is tracked.
    documentChecklistItem: {
      findUnique: trackChecklist('findUnique'),
      findMany: trackChecklist('findMany'),
      create: trackChecklist('create'),
      createMany: trackChecklist('createMany'),
      update: trackChecklist('update'),
      updateMany: trackChecklist('updateMany'),
      upsert: trackChecklist('upsert'),
      delete: trackChecklist('delete'),
      deleteMany: trackChecklist('deleteMany'),
    },
  } as unknown as PrismaClient;

  return { prisma, catalog, checklistCalls };
}

describe('DocumentCatalogService.get', () => {
  it('falls back to built-in defaults for an unconfigured market (Req 12.4)', async () => {
    const { prisma } = fakePrisma();
    const service = new DocumentCatalogService(prisma);

    const docs = await service.get('JAPAN');

    expect(docs).toEqual(defaultDocsForMarket('JAPAN'));
    expect(docs).toEqual(Array.from(DEFAULT_DOC_CATALOG.JAPAN));
  });

  it('returns the persisted docs when a catalog row exists (Req 12.4)', async () => {
    const persisted: DocTypeDef[] = [{ type: 'PASSPORT', label: 'Hộ chiếu', required: true }];
    const { prisma } = fakePrisma([
      { id: 'cat-1', market: 'KOREA', docs: persisted, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const service = new DocumentCatalogService(prisma);

    const docs = await service.get('KOREA');

    expect(docs).toEqual(persisted);
  });

  it('rejects an invalid market code with a 400 ValidationError', async () => {
    const { prisma } = fakePrisma();
    const service = new DocumentCatalogService(prisma);

    await expect(service.get('ATLANTIS')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('DocumentCatalogService.update', () => {
  it('persists the new docs and reads them back (Req 12.4)', async () => {
    const { prisma, catalog } = fakePrisma();
    const service = new DocumentCatalogService(prisma);
    const newDocs: DocTypeDef[] = [
      { type: 'PASSPORT', label: 'Hộ chiếu', required: true },
      { type: 'ID_PHOTO', label: 'Ảnh thẻ', required: false },
    ];

    const returned = await service.update('GERMANY', newDocs);

    expect(returned).toEqual(newDocs);
    expect(catalog.get('GERMANY')?.docs).toEqual(newDocs);

    const reread = await service.get('GERMANY');
    expect(reread).toEqual(newDocs);
  });

  it('trims fields and rejects entries with blank type/label (Req 12.5 validation)', async () => {
    const { prisma } = fakePrisma();
    const service = new DocumentCatalogService(prisma);

    await expect(
      service.update('JAPAN', [{ type: '   ', label: 'Hộ chiếu', required: true }]),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      service.update('JAPAN', [{ type: 'PASSPORT', label: '   ', required: true }]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does NOT issue any write or read to documentChecklistItem (Req 12.5)', async () => {
    const { prisma, checklistCalls } = fakePrisma();
    const service = new DocumentCatalogService(prisma);

    await service.update('TAIWAN', [{ type: 'PASSPORT', label: 'Hộ chiếu', required: true }]);

    // The checklist table must be completely untouched by a catalog update.
    expect(checklistCalls.count).toBe(0);
    expect(checklistCalls.methods).toEqual([]);
  });
});
