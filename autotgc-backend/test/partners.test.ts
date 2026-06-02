/**
 * Route + service tests for Partners & Destinations (đối tác / nơi đưa đi XKLĐ).
 *
 * Mirrors the in-memory Fastify-double + fake-Prisma pattern from
 * `reportingRoutes.test.ts`: a minimal Fastify test double captures the
 * registered handlers so we can invoke their bodies directly (the
 * requireAuth/rbacGuard preHandlers are out of scope here — they are covered by
 * the shared auth-middleware tests; these handlers delegate to the services).
 *
 * Covers:
 *   - POST /api/v1/partners → create validation (400 on blank name) + 201 ok
 *   - GET  /api/v1/partners → list filter (type) narrows results
 *   - GET  /api/v1/partners/:id → 404 on unknown id
 *   - POST /api/v1/partners/:id/status → status toggle + 400 on bad value
 *   - POST /api/v1/destinations → create validation (400 blank name/country),
 *     coerces a non-array/loose `industries` into a clean string[]
 *   - GET  /api/v1/destinations → activeOnly filter
 *   - POST /api/v1/destinations/:id/active → active toggle
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { registerPartnerRoutes } from '../src/partners/routes';
import { ValidationError, NotFoundError } from '../src/infra/errors';
import type { JwtService } from '../src/auth/jwt';

// ===========================================================================
// In-memory Prisma fake — only partnerOrg + destinationProgram methods.
// ===========================================================================

interface PartnerRow {
  id: string;
  name: string;
  type: string;
  country: string;
  contactName: string;
  phone: string;
  email: string;
  status: string;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DestinationRow {
  id: string;
  name: string;
  country: string;
  visaType: string;
  partnerId: string | null;
  minAge: number | null;
  maxAge: number | null;
  gender: string;
  requiredLanguage: string;
  minLanguageLevel: string;
  budgetMinVndM: number | null;
  budgetMaxVndM: number | null;
  industries: unknown;
  conditions: unknown;
  status: string;
  notes: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NOW = new Date('2025-06-09T00:00:00.000Z');

function makePrismaFake(
  partners: PartnerRow[] = [],
  destinations: DestinationRow[] = [],
): { prisma: PrismaClient; partners: PartnerRow[]; destinations: DestinationRow[] } {
  const pStore = [...partners];
  const dStore = [...destinations];
  let seq = pStore.length + dStore.length;

  const partnerMatches = (row: PartnerRow, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    if (where.type !== undefined && row.type !== where.type) return false;
    if (where.country !== undefined && row.country !== where.country) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    return true;
  };

  const destMatches = (row: DestinationRow, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    if (where.country !== undefined && row.country !== where.country) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.active !== undefined && row.active !== where.active) return false;
    return true;
  };

  const prisma = {
    partnerOrg: {
      create: async (args: { data: Record<string, unknown> }) => {
        const d = args.data as Partial<PartnerRow>;
        const row: PartnerRow = {
          id: `partner-${++seq}`,
          name: d.name as string,
          type: (d.type as string) ?? 'EMPLOYER',
          country: (d.country as string) ?? '',
          contactName: (d.contactName as string) ?? '',
          phone: (d.phone as string) ?? '',
          email: (d.email as string) ?? '',
          status: (d.status as string) ?? 'ACTIVE',
          notes: (d.notes as string) ?? '',
          createdAt: NOW,
          updatedAt: NOW,
        };
        pStore.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        pStore.find((r) => r.id === args.where.id) ?? null,
      findMany: async (args?: { where?: Record<string, unknown>; skip?: number; take?: number }) => {
        const filtered = pStore.filter((r) => partnerMatches(r, args?.where));
        const skip = args?.skip ?? 0;
        const take = args?.take ?? filtered.length;
        return filtered.slice(skip, skip + take);
      },
      count: async (args?: { where?: Record<string, unknown> }) =>
        pStore.filter((r) => partnerMatches(r, args?.where)).length,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = pStore.findIndex((r) => r.id === args.where.id);
        const updated = { ...pStore[idx], ...(args.data as Partial<PartnerRow>), updatedAt: NOW };
        pStore[idx] = updated;
        return updated;
      },
    },
    destinationProgram: {
      create: async (args: { data: Record<string, unknown> }) => {
        const d = args.data as Record<string, unknown>;
        const partnerRel = d.partner as { connect?: { id: string } } | undefined;
        const row: DestinationRow = {
          id: `dest-${++seq}`,
          name: d.name as string,
          country: d.country as string,
          visaType: (d.visaType as string) ?? '',
          partnerId: partnerRel?.connect?.id ?? null,
          minAge: (d.minAge as number | null) ?? null,
          maxAge: (d.maxAge as number | null) ?? null,
          gender: (d.gender as string) ?? 'ANY',
          requiredLanguage: (d.requiredLanguage as string) ?? '',
          minLanguageLevel: (d.minLanguageLevel as string) ?? '',
          budgetMinVndM: (d.budgetMinVndM as number | null) ?? null,
          budgetMaxVndM: (d.budgetMaxVndM as number | null) ?? null,
          industries: d.industries ?? [],
          conditions: d.conditions ?? [],
          status: (d.status as string) ?? 'OPEN',
          notes: (d.notes as string) ?? '',
          active: (d.active as boolean) ?? true,
          createdAt: NOW,
          updatedAt: NOW,
        };
        dStore.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        dStore.find((r) => r.id === args.where.id) ?? null,
      findMany: async (args?: { where?: Record<string, unknown>; skip?: number; take?: number }) => {
        const filtered = dStore.filter((r) => destMatches(r, args?.where));
        const skip = args?.skip ?? 0;
        const take = args?.take ?? filtered.length;
        return filtered.slice(skip, skip + take);
      },
      count: async (args?: { where?: Record<string, unknown> }) =>
        dStore.filter((r) => destMatches(r, args?.where)).length,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = dStore.findIndex((r) => r.id === args.where.id);
        const updated = {
          ...dStore[idx],
          ...(args.data as Partial<DestinationRow>),
          updatedAt: NOW,
        };
        dStore[idx] = updated;
        return updated;
      },
    },
  } as unknown as PrismaClient;

  return { prisma, partners: pStore, destinations: dStore };
}

function makePartner(over: Partial<PartnerRow> & { id: string }): PartnerRow {
  return {
    id: over.id,
    name: over.name ?? 'Đối tác A',
    type: over.type ?? 'EMPLOYER',
    country: over.country ?? 'JAPAN',
    contactName: over.contactName ?? '',
    phone: over.phone ?? '',
    email: over.email ?? '',
    status: over.status ?? 'ACTIVE',
    notes: over.notes ?? '',
    createdAt: over.createdAt ?? NOW,
    updatedAt: over.updatedAt ?? NOW,
  };
}

function makeDestination(over: Partial<DestinationRow> & { id: string }): DestinationRow {
  return {
    id: over.id,
    name: over.name ?? 'Chương trình A',
    country: over.country ?? 'JAPAN',
    visaType: over.visaType ?? '',
    partnerId: over.partnerId ?? null,
    minAge: over.minAge ?? null,
    maxAge: over.maxAge ?? null,
    gender: over.gender ?? 'ANY',
    requiredLanguage: over.requiredLanguage ?? '',
    minLanguageLevel: over.minLanguageLevel ?? '',
    budgetMinVndM: over.budgetMinVndM ?? null,
    budgetMaxVndM: over.budgetMaxVndM ?? null,
    industries: over.industries ?? [],
    conditions: over.conditions ?? [],
    status: over.status ?? 'OPEN',
    notes: over.notes ?? '',
    active: over.active ?? true,
    createdAt: over.createdAt ?? NOW,
    updatedAt: over.updatedAt ?? NOW,
  };
}

// ===========================================================================
// Fastify test double — captures handlers so we can invoke bodies directly.
// ===========================================================================

interface CapturedRoute {
  method: 'get' | 'post' | 'put';
  path: string;
  handler: (request: any, reply: any) => Promise<unknown>;
}

function makeAppDouble(): { app: FastifyInstance; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = [];
  const register =
    (method: CapturedRoute['method']) =>
    (path: string, _opts: unknown, handler: CapturedRoute['handler']) => {
      routes.push({ method, path, handler });
    };
  const app = {
    get: register('get'),
    post: register('post'),
    put: register('put'),
  } as unknown as FastifyInstance;
  return { app, routes };
}

function makeReply(): { reply: any; sent: { code: number; body: unknown } } {
  const sent = { code: 200, body: undefined as unknown };
  const reply = {
    code(this: any, c: number) {
      sent.code = c;
      return this;
    },
    send(this: any, body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { reply, sent };
}

function registerRoutes(prisma: PrismaClient): Map<string, CapturedRoute> {
  const { app, routes } = makeAppDouble();
  registerPartnerRoutes(app, { prisma, jwt: {} as JwtService });
  const map = new Map<string, CapturedRoute>();
  for (const r of routes) map.set(`${r.method.toUpperCase()} ${r.path}`, r);
  return map;
}

const ADMIN = { userId: 'admin', role: 'ADMIN' as const, sessionId: 's1' };

// ===========================================================================
// Partners
// ===========================================================================

describe('POST /api/v1/partners', () => {
  it('creates a partner and responds 201', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/partners')!;
    const { reply, sent } = makeReply();

    await route.handler(
      { body: { name: 'Nghiệp đoàn Tokyo', type: 'EMPLOYER', country: 'JAPAN' }, auth: ADMIN, query: {}, params: {} },
      reply,
    );

    expect(sent.code).toBe(201);
    const view = sent.body as { id: string; name: string; type: string };
    expect(view.name).toBe('Nghiệp đoàn Tokyo');
    expect(view.type).toBe('EMPLOYER');
  });

  it('rejects a blank name with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/partners')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ body: { name: '   ' }, auth: ADMIN, query: {}, params: {} }, reply),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an invalid type with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/partners')!;
    const { reply } = makeReply();

    await expect(
      route.handler(
        { body: { name: 'X', type: 'NONSENSE' }, auth: ADMIN, query: {}, params: {} },
        reply,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('GET /api/v1/partners', () => {
  it('filters the list by type', async () => {
    const { prisma } = makePrismaFake([
      makePartner({ id: 'p-emp', type: 'EMPLOYER' }),
      makePartner({ id: 'p-school', type: 'SCHOOL' }),
    ]);
    const route = registerRoutes(prisma).get('GET /api/v1/partners')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: ADMIN, query: { type: 'SCHOOL' }, params: {} }, reply);

    expect(sent.code).toBe(200);
    const body = sent.body as { items: Array<{ id: string; type: string }>; total: number; page: number; limit: number };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('p-school');
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });
});

describe('GET /api/v1/partners/:id', () => {
  it('returns 404 (NotFoundError) for an unknown id', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('GET /api/v1/partners/:id')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ params: { id: 'missing' }, auth: ADMIN, query: {} }, reply),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('POST /api/v1/partners/:id/status', () => {
  it('toggles the partner status (200)', async () => {
    const { prisma } = makePrismaFake([makePartner({ id: 'p1', status: 'ACTIVE' })]);
    const route = registerRoutes(prisma).get('POST /api/v1/partners/:id/status')!;
    const { reply, sent } = makeReply();

    await route.handler(
      { params: { id: 'p1' }, body: { status: 'PAUSED' }, auth: ADMIN, query: {} },
      reply,
    );

    expect(sent.code).toBe(200);
    expect((sent.body as { status: string }).status).toBe('PAUSED');
  });

  it('rejects an invalid status with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake([makePartner({ id: 'p1', status: 'ACTIVE' })]);
    const route = registerRoutes(prisma).get('POST /api/v1/partners/:id/status')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ params: { id: 'p1' }, body: { status: 'BOGUS' }, auth: ADMIN, query: {} }, reply),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ===========================================================================
// Destinations
// ===========================================================================

describe('POST /api/v1/destinations', () => {
  it('creates a program and coerces a loose industries value into a string[] (201)', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/destinations')!;
    const { reply, sent } = makeReply();

    await route.handler(
      {
        body: {
          name: 'Kỹ năng đặc định - Xây dựng',
          country: 'JAPAN',
          // mixed array with blanks + non-strings — must be cleaned to a string[]
          industries: ['Xây dựng', '  ', 42, 'Điều dưỡng', null],
          conditions: 'not-an-array',
        },
        auth: ADMIN,
        query: {},
        params: {},
      },
      reply,
    );

    expect(sent.code).toBe(201);
    const view = sent.body as { industries: unknown; conditions: unknown };
    expect(view.industries).toEqual(['Xây dựng', 'Điều dưỡng']);
    // Non-array conditions coerce to an empty array (defensive).
    expect(view.conditions).toEqual([]);
  });

  it('rejects a blank name with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/destinations')!;
    const { reply } = makeReply();

    await expect(
      route.handler(
        { body: { name: '', country: 'JAPAN' }, auth: ADMIN, query: {}, params: {} },
        reply,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a blank country with a 400 ValidationError', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('POST /api/v1/destinations')!;
    const { reply } = makeReply();

    await expect(
      route.handler(
        { body: { name: 'Chương trình', country: '   ' }, auth: ADMIN, query: {}, params: {} },
        reply,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('GET /api/v1/destinations', () => {
  it('filters by activeOnly', async () => {
    const { prisma } = makePrismaFake(
      [],
      [
        makeDestination({ id: 'd-open', active: true }),
        makeDestination({ id: 'd-closed', active: false }),
      ],
    );
    const route = registerRoutes(prisma).get('GET /api/v1/destinations')!;
    const { reply, sent } = makeReply();

    await route.handler({ auth: ADMIN, query: { activeOnly: 'true' }, params: {} }, reply);

    expect(sent.code).toBe(200);
    const body = sent.body as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('d-open');
  });
});

describe('GET /api/v1/destinations/:id', () => {
  it('returns 404 (NotFoundError) for an unknown id', async () => {
    const { prisma } = makePrismaFake();
    const route = registerRoutes(prisma).get('GET /api/v1/destinations/:id')!;
    const { reply } = makeReply();

    await expect(
      route.handler({ params: { id: 'missing' }, auth: ADMIN, query: {} }, reply),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('POST /api/v1/destinations/:id/active', () => {
  it('toggles the active flag off (200)', async () => {
    const { prisma } = makePrismaFake([], [makeDestination({ id: 'd1', active: true })]);
    const route = registerRoutes(prisma).get('POST /api/v1/destinations/:id/active')!;
    const { reply, sent } = makeReply();

    await route.handler(
      { params: { id: 'd1' }, body: { active: 'false' }, auth: ADMIN, query: {} },
      reply,
    );

    expect(sent.code).toBe(200);
    // 'false' string is not truthy under asBool → active becomes false.
    expect((sent.body as { active: boolean }).active).toBe(false);
  });
});
