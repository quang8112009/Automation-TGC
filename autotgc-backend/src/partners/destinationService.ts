/**
 * DestinationService — CRUD + filtering + active/status changes over the
 * DestinationProgram model (nơi có thể đưa đi XKLĐ + điều kiện cụ thể).
 *
 * Mirrors the recruitment JobOrderService layering: pure domain rules + enum
 * narrowing live here; request/response shaping stays in routes.ts. `name` and
 * `country` must be non-blank; the `industries`/`conditions` Json columns are
 * coerced to `string[]` defensively. Additive module — does not modify existing
 * files. The eligibility-condition strings stored here are what the
 * Destination_Matcher evaluates against a candidate profile.
 */
import type { DestinationProgram, Prisma, PrismaClient } from '@prisma/client';
import { blank } from '../recruitment/validation';
import { NotFoundError, ValidationError } from '../infra/errors';

export type DestinationStatusValue = 'OPEN' | 'PAUSED' | 'CLOSED';

export const DESTINATION_STATUSES: readonly DestinationStatusValue[] = [
  'OPEN', 'PAUSED', 'CLOSED',
];

export function isDestinationStatus(v: unknown): v is DestinationStatusValue {
  return typeof v === 'string' && (DESTINATION_STATUSES as readonly string[]).includes(v);
}

/** Coerce an unknown value into a clean string[] (defensive, drops blanks). */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export interface CreateDestinationInput {
  name?: string;
  country?: string;
  visaType?: string;
  partnerId?: string | null;
  minAge?: number | null;
  maxAge?: number | null;
  gender?: string;
  requiredLanguage?: string;
  minLanguageLevel?: string;
  budgetMinVndM?: number | null;
  budgetMaxVndM?: number | null;
  industries?: unknown;
  conditions?: unknown;
  status?: string;
  notes?: string;
  active?: boolean;
}

export type UpdateDestinationInput = CreateDestinationInput;

export interface DestinationListFilter {
  country?: string;
  status?: string;
  activeOnly?: boolean;
}

export interface DestinationListResult {
  items: DestinationProgram[];
  total: number;
  page: number;
  limit: number;
}

export class DestinationService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateDestinationInput): Promise<DestinationProgram> {
    if (blank(input.name)) {
      throw new ValidationError('name is required', 'NAME_REQUIRED');
    }
    if (blank(input.country)) {
      throw new ValidationError('country is required', 'COUNTRY_REQUIRED');
    }
    let status: DestinationStatusValue | undefined;
    if (input.status !== undefined) {
      if (!isDestinationStatus(input.status)) {
        throw new ValidationError(`Invalid status: ${String(input.status)}`, 'INVALID_DESTINATION_STATUS');
      }
      status = input.status;
    }

    const data: Prisma.DestinationProgramCreateInput = {
      name: (input.name as string).trim(),
      country: (input.country as string).trim(),
      visaType: input.visaType ?? '',
      gender: input.gender ?? 'ANY',
      requiredLanguage: input.requiredLanguage ?? '',
      minLanguageLevel: input.minLanguageLevel ?? '',
      minAge: input.minAge ?? null,
      maxAge: input.maxAge ?? null,
      budgetMinVndM: input.budgetMinVndM ?? null,
      budgetMaxVndM: input.budgetMaxVndM ?? null,
      industries: toStringArray(input.industries) as unknown as Prisma.InputJsonValue,
      conditions: toStringArray(input.conditions) as unknown as Prisma.InputJsonValue,
      notes: input.notes ?? '',
    };
    if (status) data.status = status;
    if (input.active !== undefined) data.active = input.active;
    if (input.partnerId) data.partner = { connect: { id: input.partnerId } };

    return this.prisma.destinationProgram.create({ data });
  }

  async list(
    filter: DestinationListFilter,
    page: number,
    limit: number,
  ): Promise<DestinationListResult> {
    const where = this.buildWhere(filter);
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;

    const [items, total] = await Promise.all([
      this.prisma.destinationProgram.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.destinationProgram.count({ where }),
    ]);
    return { items, total, page: safePage, limit: safeLimit };
  }

  async get(id: string): Promise<DestinationProgram> {
    const program = await this.prisma.destinationProgram.findUnique({ where: { id } });
    if (!program) {
      throw new NotFoundError('Destination program not found');
    }
    return program;
  }

  async update(id: string, input: UpdateDestinationInput): Promise<DestinationProgram> {
    const current = await this.prisma.destinationProgram.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundError('Destination program not found');
    }
    let status: DestinationStatusValue | undefined;
    if (input.status !== undefined) {
      if (!isDestinationStatus(input.status)) {
        throw new ValidationError(`Invalid status: ${String(input.status)}`, 'INVALID_DESTINATION_STATUS');
      }
      status = input.status;
    }

    const data: Prisma.DestinationProgramUpdateInput = {};
    if (input.name !== undefined) {
      if (blank(input.name)) {
        throw new ValidationError('name is required', 'NAME_REQUIRED');
      }
      data.name = input.name.trim();
    }
    if (input.country !== undefined) {
      if (blank(input.country)) {
        throw new ValidationError('country is required', 'COUNTRY_REQUIRED');
      }
      data.country = input.country.trim();
    }
    if (input.visaType !== undefined) data.visaType = input.visaType;
    if (input.gender !== undefined) data.gender = input.gender;
    if (input.requiredLanguage !== undefined) data.requiredLanguage = input.requiredLanguage;
    if (input.minLanguageLevel !== undefined) data.minLanguageLevel = input.minLanguageLevel;
    if (input.minAge !== undefined) data.minAge = input.minAge;
    if (input.maxAge !== undefined) data.maxAge = input.maxAge;
    if (input.budgetMinVndM !== undefined) data.budgetMinVndM = input.budgetMinVndM;
    if (input.budgetMaxVndM !== undefined) data.budgetMaxVndM = input.budgetMaxVndM;
    if (input.industries !== undefined) {
      data.industries = toStringArray(input.industries) as unknown as Prisma.InputJsonValue;
    }
    if (input.conditions !== undefined) {
      data.conditions = toStringArray(input.conditions) as unknown as Prisma.InputJsonValue;
    }
    if (input.notes !== undefined) data.notes = input.notes;
    if (status) data.status = status;
    if (input.active !== undefined) data.active = input.active;
    if (input.partnerId !== undefined) {
      data.partner = input.partnerId ? { connect: { id: input.partnerId } } : { disconnect: true };
    }

    return this.prisma.destinationProgram.update({ where: { id }, data });
  }

  async setActive(id: string, active: boolean): Promise<DestinationProgram> {
    const current = await this.prisma.destinationProgram.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundError('Destination program not found');
    }
    return this.prisma.destinationProgram.update({ where: { id }, data: { active } });
  }

  private buildWhere(filter: DestinationListFilter): Prisma.DestinationProgramWhereInput {
    const where: Prisma.DestinationProgramWhereInput = {};
    if (filter.country !== undefined) where.country = filter.country;
    if (filter.status !== undefined) {
      if (!isDestinationStatus(filter.status)) {
        throw new ValidationError(`Invalid status: ${String(filter.status)}`, 'INVALID_DESTINATION_STATUS');
      }
      where.status = filter.status;
    }
    if (filter.activeOnly) where.active = true;
    return where;
  }
}
