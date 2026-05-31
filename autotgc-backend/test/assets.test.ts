import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import {
  ASSET_KINDS,
  DEFAULT_DIMENSIONS,
  isAssetKind,
} from '../src/marketing/assets/assetKinds';
import type { AssetKind } from '../src/marketing/assets/assetKinds';
import {
  AssetGenerator,
  resolveRenderSpec,
  fallbackBrandSpec,
} from '../src/marketing/assets/assetGenerator';
import type { AssetCopy, RenderProvider } from '../src/marketing/assets/assetGenerator';
import {
  BrandTemplateService,
  defaultBrandSpec,
} from '../src/marketing/assets/brandTemplateService';

// ---- Fakes ------------------------------------------------------------------

interface AssetRow {
  id: string;
  draftId: string | null;
  kind: string;
  templateId: string | null;
  prompt: string;
  spec: unknown;
  status: string;
  storageKey: string | null;
  mimeType: string | null;
  provider: string;
}

interface DraftSeed {
  id: string;
  title: string;
  body: string;
  market?: string | null;
  ctas: string[];
}

/**
 * Minimal Prisma fake covering the AssetGenerator code paths: draft lookup
 * (with ctas), brand-template lookup, and generatedAsset create/update/find.
 */
function fakeAssetPrisma(opts: { draft?: DraftSeed | null } = {}): {
  prisma: PrismaClient;
  assets: AssetRow[];
} {
  const assets: AssetRow[] = [];
  let seq = 0;
  const draft = opts.draft === undefined ? null : opts.draft;

  const prisma = {
    contentDraft: {
      findUnique: async () => {
        if (!draft) return null;
        return {
          id: draft.id,
          title: draft.title,
          body: draft.body,
          market: draft.market ?? null,
          ctas: draft.ctas.map((ctaText, i) => ({ id: `cta-${i}`, draftId: draft.id, ctaText })),
        };
      },
    },
    brandTemplate: {
      // No templates in these unit tests -> generator uses the fallback spec.
      findUnique: async () => null,
      findFirst: async () => null,
    },
    generatedAsset: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: AssetRow = {
          id: `asset-${++seq}`,
          draftId: (args.data.draftId as string | null) ?? null,
          kind: args.data.kind as string,
          templateId: (args.data.templateId as string | null) ?? null,
          prompt: (args.data.prompt as string) ?? '',
          spec: args.data.spec,
          status: (args.data.status as string) ?? 'SPEC_READY',
          storageKey: (args.data.storageKey as string | null) ?? null,
          mimeType: (args.data.mimeType as string | null) ?? null,
          provider: (args.data.provider as string) ?? 'none',
        };
        assets.push(row);
        return { ...row };
      },
      findUnique: async (args: { where: { id: string } }) => {
        const found = assets.find((a) => a.id === args.where.id);
        return found ? { ...found } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = assets.find((a) => a.id === args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data);
        return { ...row };
      },
    },
  } as unknown as PrismaClient;

  return { prisma, assets };
}

/** Prisma fake for BrandTemplateService duplicate-name conflict. */
function fakeTemplatePrisma(existingNames: string[]): PrismaClient {
  return {
    brandTemplate: {
      findUnique: async (args: { where: { name?: string } }) =>
        args.where.name && existingNames.includes(args.where.name)
          ? { id: 'tpl-1', name: args.where.name, kind: 'poster', spec: {}, active: true }
          : null,
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'tpl-new', ...args.data }),
    },
  } as unknown as PrismaClient;
}

// ---- Generators -------------------------------------------------------------

const assetKindArb: fc.Arbitrary<AssetKind> = fc.constantFrom(...ASSET_KINDS);

const copyArb: fc.Arbitrary<AssetCopy> = fc.record({
  title: fc.string({ minLength: 1, maxLength: 80 }),
  body: fc.string({ maxLength: 500 }),
  ctas: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 4 }),
  market: fc.option(fc.constantFrom('JAPAN', 'KOREA', 'GERMANY', 'TAIWAN'), { nil: undefined }),
});

// ---- Property: render spec resolution --------------------------------------

describe('marketing-autopilot brand assets', () => {
  // Feature: marketing-autopilot, Property 4: render spec resolution
  it('Property 4: resolveRenderSpec is deterministic and well-formed for every kind', () => {
    fc.assert(
      fc.property(assetKindArb, copyArb, (kind, copy) => {
        const brandSpec = fallbackBrandSpec(kind);
        const a = resolveRenderSpec(kind, brandSpec, copy);
        const b = resolveRenderSpec(kind, brandSpec, copy);

        // Deterministic: identical inputs -> identical output.
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));

        // Correct per-kind dimensions.
        expect(a.dimensions).toEqual(DEFAULT_DIMENSIONS[kind]);
        expect(a.kind).toBe(kind);

        // Non-empty slots; text derived from the copy; headline === title.
        expect(a.slots.length).toBeGreaterThan(0);
        const headline = a.slots.find((s) => s.text === copy.title);
        expect(headline).toBeDefined();

        // Palette + fonts present and complete.
        expect(a.palette.primary.length).toBeGreaterThan(0);
        expect(a.palette.secondary.length).toBeGreaterThan(0);
        expect(a.palette.bg.length).toBeGreaterThan(0);
        expect(a.palette.text.length).toBeGreaterThan(0);
        expect(a.fonts.heading.length).toBeGreaterThan(0);
        expect(a.fonts.body.length).toBeGreaterThan(0);
        expect(a.logo.position.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('isAssetKind guards the five kinds', () => {
    for (const k of ASSET_KINDS) expect(isAssetKind(k)).toBe(true);
    expect(isAssetKind('banner')).toBe(false);
    expect(isAssetKind(42)).toBe(false);
  });
});

// ---- Unit: generateForDraft persistence paths ------------------------------

const DRAFT: DraftSeed = {
  id: 'draft-1',
  title: 'Tuyển dụng kỹ sư đi Nhật',
  body: 'Cơ hội làm việc tại Nhật Bản với mức lương hấp dẫn. Hỗ trợ toàn diện.',
  market: 'JAPAN',
  ctas: ['Đăng ký ngay', 'Tìm hiểu thêm'],
};

describe('AssetGenerator.generateForDraft persistence', () => {
  it('persists SPEC_READY with provider "none" when no render provider', async () => {
    const { prisma, assets } = fakeAssetPrisma({ draft: DRAFT });
    const generator = new AssetGenerator(prisma);

    const asset = await generator.generateForDraft('draft-1', 'poster');

    expect(asset.status).toBe('SPEC_READY');
    expect(asset.provider).toBe('none');
    expect(asset.storageKey).toBeNull();
    expect(asset.draftId).toBe('draft-1');
    expect(asset.kind).toBe('poster');
    expect(asset.prompt.length).toBeGreaterThan(0);
    expect(assets).toHaveLength(1);
  });

  it('persists RENDERED when a render provider returns a file', async () => {
    const { prisma } = fakeAssetPrisma({ draft: DRAFT });
    const provider: RenderProvider = {
      name: 'stub-provider',
      render: async () => ({ storageKey: 'rendered/asset-1.png', mimeType: 'image/png' }),
    };
    const generator = new AssetGenerator(prisma, provider);

    const asset = await generator.generateForDraft('draft-1', 'thumbnail');

    expect(asset.status).toBe('RENDERED');
    expect(asset.storageKey).toBe('rendered/asset-1.png');
    expect(asset.mimeType).toBe('image/png');
    expect(asset.provider).toBe('stub-provider');
  });

  it('persists FAILED when the render provider throws (no fake artifact)', async () => {
    const { prisma } = fakeAssetPrisma({ draft: DRAFT });
    const provider: RenderProvider = {
      render: async () => {
        throw new Error('provider exploded');
      },
    };
    const generator = new AssetGenerator(prisma, provider);

    const asset = await generator.generateForDraft('draft-1', 'short_video');

    expect(asset.status).toBe('FAILED');
    expect(asset.storageKey).toBeNull();
    expect(asset.mimeType).toBeNull();
  });

  it('throws 404 when the draft is missing', async () => {
    const { prisma } = fakeAssetPrisma({ draft: null });
    const generator = new AssetGenerator(prisma);

    await expect(generator.generateForDraft('missing', 'poster')).rejects.toMatchObject({
      status: 404,
      code: 'DRAFT_NOT_FOUND',
    });
  });
});

// ---- Unit: brand template duplicate name -> 409 ----------------------------

describe('BrandTemplateService.create', () => {
  it('rejects a duplicate name with 409 ConflictError', async () => {
    const prisma = fakeTemplatePrisma(['default-poster']);
    const service = new BrandTemplateService(prisma);

    await expect(
      service.create({ name: 'default-poster', kind: 'poster' }),
    ).rejects.toMatchObject({ status: 409, code: 'BRAND_TEMPLATE_NAME_TAKEN' });
  });

  it('creates a template when the name is free', async () => {
    const prisma = fakeTemplatePrisma([]);
    const service = new BrandTemplateService(prisma);

    const tpl = await service.create({ name: 'tg-poster', kind: 'poster' });
    expect(tpl.name).toBe('tg-poster');
    expect(tpl.kind).toBe('poster');
  });

  it('defaultBrandSpec returns a complete spec for each template kind', () => {
    for (const kind of ['thumbnail', 'infographic', 'poster', 'short_video'] as const) {
      const spec = defaultBrandSpec(kind);
      expect(spec.palette.primary.length).toBeGreaterThan(0);
      expect(spec.layoutSlots.some((s) => s.role === 'headline')).toBe(true);
    }
  });
});
