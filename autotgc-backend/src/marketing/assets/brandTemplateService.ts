/**
 * Brand_Template_Service — manage reusable brand "skins" (palette, fonts, logo
 * placement, layout slots) that the AssetGenerator resolves into a deterministic
 * render SPEC (customer: Thanh Giang, XKLĐ).
 *
 * Domain logic is kept framework-free; the route layer shapes requests/responses.
 * `spec` is persisted as a Json column, so values are serialized through
 * `toInputJson` (JSON.parse(JSON.stringify(x))) into `Prisma.InputJsonValue`.
 *
 * HONESTY NOTE: a template only describes HOW an asset should look. No image or
 * video is produced here.
 */
import { Prisma } from '@prisma/client';
import type { BrandTemplate, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../infra/errors';
import { TEMPLATE_KINDS, isTemplateKind } from './assetKinds';
import type { TemplateKind } from './assetKinds';

/** A color palette for a brand template. */
export interface BrandPalette {
  primary: string;
  secondary: string;
  bg: string;
  text: string;
}

/** Font roles for a brand template. */
export interface BrandFonts {
  heading: string;
  body: string;
}

/** Logo placement on the canvas. */
export interface BrandLogo {
  url?: string;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
}

/** A named region the resolver fills with copy. */
export interface LayoutSlot {
  name: string;
  role: 'headline' | 'subhead' | 'body' | 'cta' | 'logo' | 'footer' | 'background';
}

/** The full, normalized brand spec stored on BrandTemplate.spec. */
export interface BrandSpec {
  palette: BrandPalette;
  fonts: BrandFonts;
  logo: BrandLogo;
  layoutSlots: LayoutSlot[];
}

export interface CreateBrandTemplateInput {
  name: string;
  kind: string;
  spec?: unknown;
  active?: boolean;
}

export interface UpdateBrandTemplateInput {
  name?: string;
  spec?: unknown;
  active?: boolean;
}

export interface ListBrandTemplatesFilter {
  kind?: string;
  activeOnly?: boolean;
}

// ---- Thanh Giang brand defaults --------------------------------------------

/** Thanh Giang XKLĐ palette — trustworthy navy + warm gold on light ground. */
const TG_PALETTE: BrandPalette = {
  primary: '#0B3D91', // navy (uy tín)
  secondary: '#F2A900', // gold (nổi bật)
  bg: '#FFFFFF',
  text: '#1A1A1A',
};

const TG_FONTS: BrandFonts = {
  heading: 'Be Vietnam Pro', // Vietnamese-friendly display face
  body: 'Inter',
};

/**
 * A sensible default brand spec per kind. Pure: same input -> same output.
 * Layout slots vary by kind (e.g. short_video adds a footer caption line).
 */
export function defaultBrandSpec(kind: TemplateKind): BrandSpec {
  const baseSlots: LayoutSlot[] = [
    { name: 'background', role: 'background' },
    { name: 'logo', role: 'logo' },
    { name: 'headline', role: 'headline' },
  ];

  let slots: LayoutSlot[];
  switch (kind) {
    case 'thumbnail':
      slots = [...baseSlots, { name: 'subhead', role: 'subhead' }];
      break;
    case 'poster':
      slots = [
        ...baseSlots,
        { name: 'subhead', role: 'subhead' },
        { name: 'body', role: 'body' },
        { name: 'cta', role: 'cta' },
        { name: 'footer', role: 'footer' },
      ];
      break;
    case 'infographic':
      slots = [
        ...baseSlots,
        { name: 'subhead', role: 'subhead' },
        { name: 'body', role: 'body' },
        { name: 'footer', role: 'footer' },
      ];
      break;
    case 'short_video':
      slots = [
        ...baseSlots,
        { name: 'subhead', role: 'subhead' },
        { name: 'cta', role: 'cta' },
        { name: 'footer', role: 'footer' },
      ];
      break;
    default:
      slots = baseSlots;
  }

  return {
    palette: { ...TG_PALETTE },
    fonts: { ...TG_FONTS },
    logo: { position: kind === 'thumbnail' ? 'top-left' : 'top-right' },
    layoutSlots: slots,
  };
}

// ---- Validation / normalization --------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function normalizePalette(value: unknown): BrandPalette {
  const r = isRecord(value) ? value : {};
  return {
    primary: strOr(r.primary, TG_PALETTE.primary),
    secondary: strOr(r.secondary, TG_PALETTE.secondary),
    bg: strOr(r.bg, TG_PALETTE.bg),
    text: strOr(r.text, TG_PALETTE.text),
  };
}

function normalizeFonts(value: unknown): BrandFonts {
  const r = isRecord(value) ? value : {};
  return {
    heading: strOr(r.heading, TG_FONTS.heading),
    body: strOr(r.body, TG_FONTS.body),
  };
}

const LOGO_POSITIONS: ReadonlyArray<BrandLogo['position']> = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
];

function normalizeLogo(value: unknown): BrandLogo {
  const r = isRecord(value) ? value : {};
  const position = LOGO_POSITIONS.includes(r.position as BrandLogo['position'])
    ? (r.position as BrandLogo['position'])
    : 'top-right';
  const url = typeof r.url === 'string' && r.url.trim().length > 0 ? r.url : undefined;
  return url ? { url, position } : { position };
}

const SLOT_ROLES: ReadonlyArray<LayoutSlot['role']> = [
  'headline',
  'subhead',
  'body',
  'cta',
  'logo',
  'footer',
  'background',
];

function normalizeSlots(value: unknown): LayoutSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: LayoutSlot[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name : undefined;
    const role = SLOT_ROLES.includes(raw.role as LayoutSlot['role'])
      ? (raw.role as LayoutSlot['role'])
      : undefined;
    if (name && role) slots.push({ name, role });
  }
  return slots;
}

/**
 * Lightweight validation: the spec must be a JSON object. Returns a normalized
 * BrandSpec (filling sensible defaults for any missing parts) so create/update
 * always persist a complete, well-shaped spec. Throws ValidationError when the
 * provided spec is present but not an object.
 */
export function validateBrandSpec(spec: unknown): BrandSpec {
  if (spec !== undefined && spec !== null && !isRecord(spec)) {
    throw new ValidationError('Brand spec must be a JSON object', 'BRAND_SPEC_INVALID');
  }
  const r = isRecord(spec) ? spec : {};
  return {
    palette: normalizePalette(r.palette),
    fonts: normalizeFonts(r.fonts),
    logo: normalizeLogo(r.logo),
    layoutSlots: normalizeSlots(r.layoutSlots),
  };
}

/** Serialize an arbitrary JSON-able value for a Prisma Json column. */
export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Stable default-template name for a kind (used by seedDefaults + lookup). */
export function defaultTemplateName(kind: TemplateKind): string {
  return `default-${kind}`;
}

function assertTemplateKind(kind: string): TemplateKind {
  if (!isTemplateKind(kind)) {
    throw new ValidationError(
      `Unknown brand template kind: ${kind}`,
      'BRAND_TEMPLATE_KIND_INVALID',
    );
  }
  return kind;
}

// ---- Service ----------------------------------------------------------------

export interface SeedDefaultsResult {
  created: number;
  existing: number;
  total: number;
}

export class BrandTemplateService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Create a template; duplicate name -> 409 ConflictError. */
  async create(input: CreateBrandTemplateInput): Promise<BrandTemplate> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new ValidationError('Brand template name is required', 'BRAND_TEMPLATE_NAME_REQUIRED');
    }
    const kind = assertTemplateKind(input.kind);

    const existing = await this.prisma.brandTemplate.findUnique({ where: { name } });
    if (existing) {
      throw new ConflictError(
        `Brand template name already exists: ${name}`,
        'BRAND_TEMPLATE_NAME_TAKEN',
      );
    }

    const spec = validateBrandSpec(input.spec ?? defaultBrandSpec(kind));
    return this.prisma.brandTemplate.create({
      data: {
        name,
        kind,
        spec: toInputJson(spec),
        active: input.active ?? true,
      },
    });
  }

  /** Update name/spec/active; 404 if missing, 409 if renaming onto a taken name. */
  async update(id: string, input: UpdateBrandTemplateInput): Promise<BrandTemplate> {
    const current = await this.prisma.brandTemplate.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundError('Brand template not found', 'BRAND_TEMPLATE_NOT_FOUND');
    }

    const data: Prisma.BrandTemplateUpdateInput = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new ValidationError('Brand template name is required', 'BRAND_TEMPLATE_NAME_REQUIRED');
      }
      if (name !== current.name) {
        const clash = await this.prisma.brandTemplate.findUnique({ where: { name } });
        if (clash) {
          throw new ConflictError(
            `Brand template name already exists: ${name}`,
            'BRAND_TEMPLATE_NAME_TAKEN',
          );
        }
        data.name = name;
      }
    }

    if (input.spec !== undefined) {
      data.spec = toInputJson(validateBrandSpec(input.spec));
    }

    if (input.active !== undefined) {
      data.active = input.active;
    }

    return this.prisma.brandTemplate.update({ where: { id }, data });
  }

  /** Fetch by id; 404 if missing. */
  async get(id: string): Promise<BrandTemplate> {
    const tpl = await this.prisma.brandTemplate.findUnique({ where: { id } });
    if (!tpl) {
      throw new NotFoundError('Brand template not found', 'BRAND_TEMPLATE_NOT_FOUND');
    }
    return tpl;
  }

  /** List templates, optionally filtered by kind and/or active-only. */
  async list(filter: ListBrandTemplatesFilter = {}): Promise<BrandTemplate[]> {
    const where: Prisma.BrandTemplateWhereInput = {};
    if (filter.kind !== undefined) {
      where.kind = assertTemplateKind(filter.kind);
    }
    if (filter.activeOnly) {
      where.active = true;
    }
    return this.prisma.brandTemplate.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
  }

  /** The active default template for a kind (most-recently-created), or null. */
  async findActiveDefault(kind: TemplateKind): Promise<BrandTemplate | null> {
    return this.prisma.brandTemplate.findFirst({
      where: { kind, active: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Deactivate a template (soft disable); 404 if missing. */
  async deactivate(id: string): Promise<BrandTemplate> {
    const tpl = await this.prisma.brandTemplate.findUnique({ where: { id } });
    if (!tpl) {
      throw new NotFoundError('Brand template not found', 'BRAND_TEMPLATE_NOT_FOUND');
    }
    return this.prisma.brandTemplate.update({ where: { id }, data: { active: false } });
  }

  /**
   * Idempotently ensure one default template per template kind exists (keyed by
   * the unique name `default-<kind>`). Re-running creates only the missing ones.
   */
  async seedDefaults(): Promise<SeedDefaultsResult> {
    let created = 0;
    let existing = 0;
    for (const kind of TEMPLATE_KINDS) {
      const name = defaultTemplateName(kind);
      const found = await this.prisma.brandTemplate.findUnique({ where: { name } });
      if (found) {
        existing += 1;
        continue;
      }
      await this.prisma.brandTemplate.create({
        data: {
          name,
          kind,
          spec: toInputJson(defaultBrandSpec(kind)),
          active: true,
        },
      });
      created += 1;
    }
    return { created, existing, total: TEMPLATE_KINDS.length };
  }
}
