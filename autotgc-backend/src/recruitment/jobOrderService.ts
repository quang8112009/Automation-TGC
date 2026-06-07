/**
 * JobOrderService — CRUD + filtering + status changes over the JobOrder model
 * (đơn hàng tuyển dụng XKLĐ). Uses the pure recruitment validation helpers and
 * enforces code uniqueness. Pure request/response shaping stays in routes.ts;
 * this layer owns the domain rules.
 */
import type { JobOrder, Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import {
  blank,
  isJobOrderStatus,
  isRecruitmentMarket,
  isVisaType,
} from './validation';
import type {
  JobOrderStatusValue,
  RecruitmentMarketValue,
  VisaTypeValue,
} from './validation';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../infra/errors';

export interface CreateJobOrderInput {
  code?: string;
  title?: string;
  industry?: string;
  visaType?: string;
  market?: string;
  workLocation?: string;
  salaryText?: string;
  salaryMinVndM?: number | null;
  salaryMaxVndM?: number | null;
  quantity?: number;
  gender?: string;
  nationalityReq?: string;
  status?: string;
  deadline?: string | null;
  description?: string;
  sourcePostId?: string | null;
  branchId?: string | null;
}

export type UpdateJobOrderInput = Omit<CreateJobOrderInput, 'code'> & { code?: string };

export interface JobOrderListFilter {
  market?: string;
  visaType?: string;
  industry?: string;
  status?: string;
}

export interface JobOrderListResult {
  items: JobOrder[];
  total: number;
  page: number;
  limit: number;
}

function parseDeadline(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`Invalid deadline: ${value}`, 'INVALID_DEADLINE');
  }
  return d;
}

export class JobOrderService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Validate the enum fields present on an input; throws ValidationError(400). */
  private validateEnums(input: CreateJobOrderInput | UpdateJobOrderInput): {
    market?: RecruitmentMarketValue;
    visaType?: VisaTypeValue;
    status?: JobOrderStatusValue;
  } {
    let market: RecruitmentMarketValue | undefined;
    let visaType: VisaTypeValue | undefined;
    let status: JobOrderStatusValue | undefined;

    if (input.market !== undefined) {
      if (!isRecruitmentMarket(input.market)) {
        throw new ValidationError(`Invalid market: ${String(input.market)}`, 'INVALID_MARKET');
      }
      market = input.market;
    }
    if (input.visaType !== undefined) {
      if (!isVisaType(input.visaType)) {
        throw new ValidationError(`Invalid visaType: ${String(input.visaType)}`, 'INVALID_VISA_TYPE');
      }
      visaType = input.visaType;
    }
    if (input.status !== undefined) {
      if (!isJobOrderStatus(input.status)) {
        throw new ValidationError(`Invalid status: ${String(input.status)}`, 'INVALID_JOB_ORDER_STATUS');
      }
      status = input.status;
    }
    return { market, visaType, status };
  }

  async create(input: CreateJobOrderInput): Promise<JobOrder> {
    if (blank(input.code)) {
      throw new ValidationError('code is required', 'CODE_REQUIRED');
    }
    if (blank(input.title)) {
      throw new ValidationError('title is required', 'TITLE_REQUIRED');
    }
    const enums = this.validateEnums(input);
    const deadline = parseDeadline(input.deadline);

    const existing = await this.prisma.jobOrder.findUnique({
      where: { code: input.code as string },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(`Job order code already exists: ${input.code}`, 'DUPLICATE_CODE');
    }

    const data: Prisma.JobOrderCreateInput = {
      code: input.code as string,
      title: input.title as string,
      industry: input.industry ?? '',
      workLocation: input.workLocation ?? '',
      salaryText: input.salaryText ?? '',
      salaryMinVndM: input.salaryMinVndM ?? null,
      salaryMaxVndM: input.salaryMaxVndM ?? null,
      quantity: input.quantity ?? 1,
      gender: input.gender ?? 'ANY',
      nationalityReq: input.nationalityReq ?? '',
      description: input.description ?? '',
      sourcePostId: input.sourcePostId ?? null,
    };
    if (enums.market) data.market = enums.market;
    if (enums.visaType) data.visaType = enums.visaType;
    if (enums.status) data.status = enums.status;
    if (deadline !== undefined) data.deadline = deadline;
    if (input.branchId) data.branch = { connect: { id: input.branchId } };

    return this.prisma.jobOrder.create({ data });
  }

  async update(id: string, input: UpdateJobOrderInput, actor: AuthInfo): Promise<JobOrder> {
    const current = await this.prisma.jobOrder.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundError('Job order not found');
    }
    // SALES assigned-only re-check (defense-in-depth): the route guard allows an
    // UNASSIGNED order (ownerUserId undefined) through, so without this a SALES
    // user could modify any order not yet assigned to anyone. Mirrors get().
    if (actor.role === 'SALES' && current.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    const enums = this.validateEnums(input);
    const deadline = parseDeadline(input.deadline);

    if (input.code !== undefined && input.code !== current.code) {
      if (blank(input.code)) {
        throw new ValidationError('code is required', 'CODE_REQUIRED');
      }
      const clash = await this.prisma.jobOrder.findUnique({
        where: { code: input.code },
        select: { id: true },
      });
      if (clash && clash.id !== id) {
        throw new ConflictError(`Job order code already exists: ${input.code}`, 'DUPLICATE_CODE');
      }
    }

    const data: Prisma.JobOrderUpdateInput = {};
    if (input.code !== undefined) data.code = input.code;
    if (input.title !== undefined) {
      if (blank(input.title)) {
        throw new ValidationError('title is required', 'TITLE_REQUIRED');
      }
      data.title = input.title;
    }
    if (input.industry !== undefined) data.industry = input.industry;
    if (input.workLocation !== undefined) data.workLocation = input.workLocation;
    if (input.salaryText !== undefined) data.salaryText = input.salaryText;
    if (input.salaryMinVndM !== undefined) data.salaryMinVndM = input.salaryMinVndM;
    if (input.salaryMaxVndM !== undefined) data.salaryMaxVndM = input.salaryMaxVndM;
    if (input.quantity !== undefined) data.quantity = input.quantity;
    if (input.gender !== undefined) data.gender = input.gender;
    if (input.nationalityReq !== undefined) data.nationalityReq = input.nationalityReq;
    if (input.description !== undefined) data.description = input.description;
    if (input.sourcePostId !== undefined) data.sourcePostId = input.sourcePostId;
    if (enums.market) data.market = enums.market;
    if (enums.visaType) data.visaType = enums.visaType;
    if (enums.status) data.status = enums.status;
    if (deadline !== undefined) data.deadline = deadline;
    if (input.branchId !== undefined) {
      data.branch = input.branchId ? { connect: { id: input.branchId } } : { disconnect: true };
    }

    return this.prisma.jobOrder.update({ where: { id }, data });
  }

  async get(id: string, actor: AuthInfo): Promise<JobOrder> {
    const order = await this.prisma.jobOrder.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundError('Job order not found');
    }
    // SALES may only access its own assigned job-orders (mirrors CandidateService).
    // Enforced here too because an unassigned order (assignedTo null) would
    // otherwise bypass the route guard, whose ownerUserId would be undefined.
    if (actor.role === 'SALES' && order.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    return order;
  }

  async list(
    filter: JobOrderListFilter,
    page: number,
    limit: number,
    actor: AuthInfo,
  ): Promise<JobOrderListResult> {
    const where = this.buildWhere(filter, actor);
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;

    const [items, total] = await Promise.all([
      this.prisma.jobOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.jobOrder.count({ where }),
    ]);
    return { items, total, page: safePage, limit: safeLimit };
  }

  /** Matching search: same filter set as list but returns all matches (no paging). */
  async search(filter: JobOrderListFilter, actor: AuthInfo): Promise<JobOrder[]> {
    const where = this.buildWhere(filter, actor);
    return this.prisma.jobOrder.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async close(id: string, actor: AuthInfo): Promise<JobOrder> {
    return this.setStatus(id, 'CLOSED', actor);
  }

  async pause(id: string, actor: AuthInfo): Promise<JobOrder> {
    return this.setStatus(id, 'PAUSED', actor);
  }

  private async setStatus(id: string, status: JobOrderStatusValue, actor: AuthInfo): Promise<JobOrder> {
    const current = await this.prisma.jobOrder.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundError('Job order not found');
    }
    // SALES assigned-only re-check (mirrors update()/get()): fail-closed on an
    // unassigned order so a status change cannot bypass ownership scoping.
    if (actor.role === 'SALES' && current.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    return this.prisma.jobOrder.update({ where: { id }, data: { status } });
  }

  private buildWhere(filter: JobOrderListFilter, actor: AuthInfo): Prisma.JobOrderWhereInput {
    const where: Prisma.JobOrderWhereInput = {};
    if (filter.market !== undefined) {
      if (!isRecruitmentMarket(filter.market)) {
        throw new ValidationError(`Invalid market: ${String(filter.market)}`, 'INVALID_MARKET');
      }
      where.market = filter.market;
    }
    if (filter.visaType !== undefined) {
      if (!isVisaType(filter.visaType)) {
        throw new ValidationError(`Invalid visaType: ${String(filter.visaType)}`, 'INVALID_VISA_TYPE');
      }
      where.visaType = filter.visaType;
    }
    if (filter.industry !== undefined) where.industry = filter.industry;
    if (filter.status !== undefined) {
      if (!isJobOrderStatus(filter.status)) {
        throw new ValidationError(`Invalid status: ${String(filter.status)}`, 'INVALID_JOB_ORDER_STATUS');
      }
      where.status = filter.status;
    }
    // SALES sees only its own assigned job-orders (mirrors CandidateService scoping).
    if (actor.role === 'SALES') {
      where.assignedTo = actor.userId;
    }
    return where;
  }
}
