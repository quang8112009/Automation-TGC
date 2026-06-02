/**
 * PartnerService — CRUD + filtering + status changes over the PartnerOrg model
 * (đối tác đã hợp tác: chủ sử dụng lao động, trường, môi giới, dịch vụ).
 *
 * Mirrors the recruitment JobOrderService layering: pure domain rules + enum
 * narrowing live here; request/response shaping stays in routes.ts. All enum
 * inputs are narrowed defensively (ValidationError 400 on an unknown value) and
 * `name` must be non-blank. Additive module — does not modify existing files.
 */
import type { PartnerOrg, Prisma, PrismaClient } from '@prisma/client';
import { blank } from '../recruitment/validation';
import { NotFoundError, ValidationError } from '../infra/errors';

export type PartnerTypeValue = 'EMPLOYER' | 'SCHOOL' | 'BROKER' | 'SERVICE';
export type PartnerStatusValue = 'ACTIVE' | 'PAUSED' | 'ENDED';

export const PARTNER_TYPES: readonly PartnerTypeValue[] = [
  'EMPLOYER', 'SCHOOL', 'BROKER', 'SERVICE',
];

export const PARTNER_STATUSES: readonly PartnerStatusValue[] = [
  'ACTIVE', 'PAUSED', 'ENDED',
];

export function isPartnerType(v: unknown): v is PartnerTypeValue {
  return typeof v === 'string' && (PARTNER_TYPES as readonly string[]).includes(v);
}

export function isPartnerStatus(v: unknown): v is PartnerStatusValue {
  return typeof v === 'string' && (PARTNER_STATUSES as readonly string[]).includes(v);
}

export interface CreatePartnerInput {
  name?: string;
  type?: string;
  country?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  status?: string;
  notes?: string;
}

export type UpdatePartnerInput = CreatePartnerInput;

export interface PartnerListFilter {
  type?: string;
  country?: string;
  status?: string;
}

export interface PartnerListResult {
  items: PartnerOrg[];
  total: number;
  page: number;
  limit: number;
}

export class PartnerService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Validate enum fields present on an input; throws ValidationError(400). */
  private validateEnums(input: CreatePartnerInput | UpdatePartnerInput): {
    type?: PartnerTypeValue;
    status?: PartnerStatusValue;
  } {
    let type: PartnerTypeValue | undefined;
    let status: PartnerStatusValue | undefined;

    if (input.type !== undefined) {
      if (!isPartnerType(input.type)) {
        throw new ValidationError(`Invalid type: ${String(input.type)}`, 'INVALID_PARTNER_TYPE');
      }
      type = input.type;
    }
    if (input.status !== undefined) {
      if (!isPartnerStatus(input.status)) {
        throw new ValidationError(`Invalid status: ${String(input.status)}`, 'INVALID_PARTNER_STATUS');
      }
      status = input.status;
    }
    return { type, status };
  }

  async create(input: CreatePartnerInput): Promise<PartnerOrg> {
    if (blank(input.name)) {
      throw new ValidationError('name is required', 'NAME_REQUIRED');
    }
    const enums = this.validateEnums(input);

    const data: Prisma.PartnerOrgCreateInput = {
      name: (input.name as string).trim(),
      country: input.country ?? '',
      contactName: input.contactName ?? '',
      phone: input.phone ?? '',
      email: input.email ?? '',
      notes: input.notes ?? '',
    };
    if (enums.type) data.type = enums.type;
    if (enums.status) data.status = enums.status;

    return this.prisma.partnerOrg.create({ data });
  }

  async list(
    filter: PartnerListFilter,
    page: number,
    limit: number,
  ): Promise<PartnerListResult> {
    const where = this.buildWhere(filter);
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;

    const [items, total] = await Promise.all([
      this.prisma.partnerOrg.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.partnerOrg.count({ where }),
    ]);
    return { items, total, page: safePage, limit: safeLimit };
  }

  async get(id: string): Promise<PartnerOrg> {
    const partner = await this.prisma.partnerOrg.findUnique({ where: { id } });
    if (!partner) {
      throw new NotFoundError('Partner not found');
    }
    return partner;
  }

  async update(id: string, input: UpdatePartnerInput): Promise<PartnerOrg> {
    const current = await this.prisma.partnerOrg.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundError('Partner not found');
    }
    const enums = this.validateEnums(input);

    const data: Prisma.PartnerOrgUpdateInput = {};
    if (input.name !== undefined) {
      if (blank(input.name)) {
        throw new ValidationError('name is required', 'NAME_REQUIRED');
      }
      data.name = input.name.trim();
    }
    if (input.country !== undefined) data.country = input.country;
    if (input.contactName !== undefined) data.contactName = input.contactName;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.email !== undefined) data.email = input.email;
    if (input.notes !== undefined) data.notes = input.notes;
    if (enums.type) data.type = enums.type;
    if (enums.status) data.status = enums.status;

    return this.prisma.partnerOrg.update({ where: { id }, data });
  }

  async setStatus(id: string, status: string): Promise<PartnerOrg> {
    if (!isPartnerStatus(status)) {
      throw new ValidationError(`Invalid status: ${String(status)}`, 'INVALID_PARTNER_STATUS');
    }
    const current = await this.prisma.partnerOrg.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundError('Partner not found');
    }
    return this.prisma.partnerOrg.update({ where: { id }, data: { status } });
  }

  private buildWhere(filter: PartnerListFilter): Prisma.PartnerOrgWhereInput {
    const where: Prisma.PartnerOrgWhereInput = {};
    if (filter.type !== undefined) {
      if (!isPartnerType(filter.type)) {
        throw new ValidationError(`Invalid type: ${String(filter.type)}`, 'INVALID_PARTNER_TYPE');
      }
      where.type = filter.type;
    }
    if (filter.country !== undefined) where.country = filter.country;
    if (filter.status !== undefined) {
      if (!isPartnerStatus(filter.status)) {
        throw new ValidationError(`Invalid status: ${String(filter.status)}`, 'INVALID_PARTNER_STATUS');
      }
      where.status = filter.status;
    }
    return where;
  }
}
