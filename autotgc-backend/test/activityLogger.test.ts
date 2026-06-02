/**
 * Unit tests for ActivityLogger (src/oversight/activityLogger.ts) — the
 * append-only Activity_Log writer (Requirements 2.2, 2.4, 2.6, 10.6).
 *
 * Uses an in-memory Prisma fake backing the single table the logger touches:
 *   - `activityLog.create` (append), `activityLog.findMany` + `activityLog.count`
 *     (listRecent).
 *
 * The fake mirrors the relevant slice of Prisma's runtime behavior:
 *   - `create` stamps `createdAt` itself (modeling the `@default(now())` column),
 *     so the caller never supplies it — this lets us assert the server stamps the
 *     timestamp (Req 2.4) by capturing the exact `data` the logger forwarded.
 *   - `detail` is stored exactly as handed in (Req 2.6) so we can assert verbatim
 *     round-tripping through both `append` and `listRecent`.
 *
 * The append-only contract (Req 2.2, 10.6) is asserted structurally: the class
 * exposes neither an `update` nor a `delete` method (Object/typeof checks over the
 * instance and its prototype chain).
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ActivityLogger } from '../src/oversight/activityLogger';

/** An ActivityLog row as stored by the in-memory fake. */
interface ActivityRow {
  id: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: unknown;
  createdAt: Date;
}

/**
 * Build an in-memory Prisma fake for the `activityLog` table. `createArgs`
 * captures every `create` call's args so tests can assert exactly what the
 * logger forwarded (notably that it does NOT pass `createdAt`).
 */
function fakePrisma(): {
  prisma: PrismaClient;
  rows: ActivityRow[];
  createArgs: Array<{ data: Record<string, unknown> }>;
} {
  const rows: ActivityRow[] = [];
  const createArgs: Array<{ data: Record<string, unknown> }> = [];
  let seq = 0;

  const prisma = {
    activityLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        createArgs.push(args);
        const n = (seq += 1);
        // Model the `createdAt @default(now())` column: the DB/server stamps the
        // timestamp here; the caller never provides it (Req 2.4).
        const row: ActivityRow = {
          id: `act-${n}`,
          actorUserId: String(args.data.actorUserId),
          action: String(args.data.action),
          targetType: String(args.data.targetType),
          targetId: String(args.data.targetId),
          detail: args.data.detail ?? {},
          createdAt: new Date(),
        };
        rows.push(row);
        return { ...row };
      },
      findMany: async (args: {
        orderBy?: { createdAt?: 'asc' | 'desc' };
        skip?: number;
        take?: number;
      }) => {
        const sorted = [...rows].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );
        const skip = args.skip ?? 0;
        const take = args.take ?? sorted.length;
        return sorted.slice(skip, skip + take).map((r) => ({ ...r }));
      },
      count: async () => rows.length,
    },
  } as unknown as PrismaClient;

  return { prisma, rows, createArgs };
}

describe('ActivityLogger.append', () => {
  it('stamps createdAt from the server — the caller never passes it (Req 2.4)', async () => {
    const { prisma, createArgs } = fakePrisma();
    const logger = new ActivityLogger(prisma);

    const before = Date.now();
    const view = await logger.append({
      actorUserId: 'sales-1',
      action: 'DOCUMENT_VERIFIED',
      targetType: 'document',
      targetId: 'doc-1',
      detail: {},
    });
    const after = Date.now();

    // The logger forwarded the caller's fields but NOT a createdAt — the column
    // default (server time) supplies it.
    expect(createArgs).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(createArgs[0].data, 'createdAt')).toBe(false);
    expect(Object.keys(createArgs[0].data).sort()).toEqual(
      ['action', 'actorUserId', 'detail', 'targetId', 'targetType'].sort(),
    );

    // The returned view carries a server-stamped Date within the call window.
    expect(view.createdAt).toBeInstanceOf(Date);
    expect(view.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(view.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('stores detail verbatim, without transforming caller-supplied content (Req 2.6)', async () => {
    const { prisma, rows } = fakePrisma();
    const logger = new ActivityLogger(prisma);

    // A nested detail with mixed JSON value types — must round-trip unchanged.
    const detail = {
      previousStage: 'NEW',
      newStage: 'CONSULTING',
      nested: { ids: [1, 2, 3], flag: true, missing: null },
      note: 'Đã xác minh — verbatim',
      count: 0,
    };

    const view = await logger.append({
      actorUserId: 'sales-7',
      action: 'CANDIDATE_STAGE_CHANGED',
      targetType: 'candidate',
      targetId: 'cand-9',
      detail,
    });

    // Verbatim through the returned view and the persisted row.
    expect(view.detail).toEqual(detail);
    expect(rows[0].detail).toEqual(detail);

    // ...and verbatim again when read back via listRecent (Req 6.2/6.5 surface).
    const { items } = await logger.listRecent();
    expect(items).toHaveLength(1);
    expect(items[0].detail).toEqual(detail);
    // All caller fields are preserved on the view as handed in.
    expect(items[0].actorUserId).toBe('sales-7');
    expect(items[0].action).toBe('CANDIDATE_STAGE_CHANGED');
    expect(items[0].targetType).toBe('candidate');
    expect(items[0].targetId).toBe('cand-9');
  });
});

describe('ActivityLogger append-only contract (Req 2.2, 10.6)', () => {
  it('exposes NO update or delete method on the instance', () => {
    const { prisma } = fakePrisma();
    const logger = new ActivityLogger(prisma);

    // Neither a mutate nor a remove path is reachable on the instance.
    expect(typeof (logger as unknown as Record<string, unknown>).update).toBe('undefined');
    expect(typeof (logger as unknown as Record<string, unknown>).delete).toBe('undefined');
    expect('update' in logger).toBe(false);
    expect('delete' in logger).toBe(false);
  });

  it('exposes NO update or delete anywhere on the prototype chain', () => {
    const { prisma } = fakePrisma();
    const logger = new ActivityLogger(prisma);

    // Collect every method name across the prototype chain.
    const methods = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(logger);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) methods.add(name);
      proto = Object.getPrototypeOf(proto);
    }

    expect(methods.has('update')).toBe(false);
    expect(methods.has('delete')).toBe(false);
    // The only writer is append; reads go through listRecent.
    expect(methods.has('append')).toBe(true);
    expect(methods.has('listRecent')).toBe(true);
  });
});
