/**
 * CandidateService — recruitment-CRM candidate (ứng viên) lifecycle over the
 * CandidateProfile model. Routes stage changes through the guarded
 * candidateStateMachine, enforces SALES assigned-only scoping (mirrors
 * LeadService), records CandidateStageHistory, and optionally publishes
 * notification events on stage changes.
 */
import type { CandidateProfile, Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import {
  blank,
  isCandidateStage,
  isRecruitmentMarket,
  isVisaType,
} from './validation';
import {
  candidateTransition,
  CANDIDATE_STAGES,
} from './candidateStateMachine';
import type { CandidateStage } from './candidateStateMachine';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../infra/errors';
import type { EventBus } from '../infra/events';
import type { OversightService } from '../oversight/oversightService';

export interface CreateCandidateInput {
  leadId?: string | null;
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  gender?: string;
  hometown?: string;
  education?: string;
  currentJob?: string;
  desiredMarket?: string | null;
  desiredIndustry?: string;
  desiredVisaType?: string | null;
  japaneseLevel?: string;
  otherLanguage?: string;
  matchedJobOrderId?: string | null;
  branchId?: string | null;
  assignedTo?: string | null;
  note?: string | null;
  source?: string;
}

export interface UpdateCandidateInput {
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  gender?: string;
  hometown?: string;
  education?: string;
  currentJob?: string;
  desiredMarket?: string | null;
  desiredIndustry?: string;
  desiredVisaType?: string | null;
  japaneseLevel?: string;
  otherLanguage?: string;
  matchedJobOrderId?: string | null;
  branchId?: string | null;
  assignedTo?: string | null;
  note?: string | null;
  stage?: string;
}

/** Fields carried over when promoting a Lead into a CandidateProfile. */
export interface PromoteFromLeadExtra {
  fullName?: string;
  desiredMarket?: string | null;
  desiredIndustry?: string;
  desiredVisaType?: string | null;
  japaneseLevel?: string;
  otherLanguage?: string;
  hometown?: string;
  education?: string;
  currentJob?: string;
  gender?: string;
  branchId?: string | null;
  assignedTo?: string | null;
  note?: string | null;
}

export interface CandidateListFilter {
  stage?: string;
  /** Comma-separated list of stages; takes precedence over `stage` when present. */
  stageIn?: string;
  desiredMarket?: string;
  desiredVisaType?: string;
  japaneseLevel?: string;
  assignedTo?: string;
  branchId?: string;
  /** Case-insensitive contains over fullName / phone / email. */
  q?: string;
}

export interface CandidateListResult {
  items: CandidateProfile[];
  total: number;
  page: number;
  limit: number;
}

export type CandidateStatGroupBy = 'stage' | 'desiredMarket' | 'branchId';

function parseDob(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`Invalid dob: ${value}`, 'INVALID_DOB');
  }
  return d;
}

/**
 * Normalize a Vietnamese phone number for duplicate detection: strip spaces,
 * dots, dashes and parentheses, then fold the international `+84` / `0084`
 * prefixes to the national `0` prefix so e.g. `+84 90 000 0000` and
 * `0900000000` compare equal. Returns '' for blank/nullish input.
 */
export function normalizePhone(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = v.replace(/[\s.\-()]/g, '');
  if (s === '') return '';
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('0084')) s = '0' + s.slice(4);
  return s;
}

/** Normalize an email for duplicate detection: trim + lowercase. '' for nullish. */
export function normalizeEmail(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v.trim().toLowerCase();
}

export class CandidateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventBus?: EventBus,
    private readonly oversight?: OversightService,
  ) {}

  /** Best-effort notification on stage changes; never blocks the write path. */
  private async emitStageChange(
    candidate: CandidateProfile,
    previousStage: string,
    newStage: string,
  ): Promise<void> {
    if (!this.eventBus) return;
    try {
      // EventTopic has no dedicated 'candidate' channel (see infra/events.ts),
      // and that file is out of scope, so we keep publishing on 'notification'
      // but enrich the payload with { market, stage } for candidate consumers.
      await this.eventBus.publish({
        topic: 'notification',
        type: 'candidate_stage_changed',
        payload: {
          id: candidate.id,
          previousStage,
          newStage,
          stage: newStage,
          market: candidate.desiredMarket ?? null,
          assignedTo: candidate.assignedTo ?? null,
        },
      });
    } catch {
      // Event publishing is non-critical; swallow so the request still succeeds.
    }
  }

  /** Validate optional desiredMarket / desiredVisaType enum inputs. */
  private validateOptionalEnums(input: {
    desiredMarket?: string | null;
    desiredVisaType?: string | null;
  }): void {
    if (input.desiredMarket !== undefined && input.desiredMarket !== null && input.desiredMarket !== '') {
      if (!isRecruitmentMarket(input.desiredMarket)) {
        throw new ValidationError(
          `Invalid desiredMarket: ${String(input.desiredMarket)}`,
          'INVALID_DESIRED_MARKET',
        );
      }
    }
    if (input.desiredVisaType !== undefined && input.desiredVisaType !== null && input.desiredVisaType !== '') {
      if (!isVisaType(input.desiredVisaType)) {
        throw new ValidationError(
          `Invalid desiredVisaType: ${String(input.desiredVisaType)}`,
          'INVALID_DESIRED_VISA_TYPE',
        );
      }
    }
  }

  private optionalMarket(v: string | null | undefined): Prisma.CandidateProfileCreateInput['desiredMarket'] {
    return v && v !== '' ? (v as Prisma.CandidateProfileCreateInput['desiredMarket']) : null;
  }

  private optionalVisa(v: string | null | undefined): Prisma.CandidateProfileCreateInput['desiredVisaType'] {
    return v && v !== '' ? (v as Prisma.CandidateProfileCreateInput['desiredVisaType']) : null;
  }

  /**
   * Find an existing candidate that shares the same normalized phone OR email.
   * Phone is matched across `+84`/`0` prefix variants; email is matched
   * case-insensitively. Narrowed at the DB layer then re-confirmed in app code
   * so stored values containing spaces/dots/dashes still compare equal.
   */
  async findDuplicate(
    phone?: string | null,
    email?: string | null,
  ): Promise<CandidateProfile | null> {
    const np = normalizePhone(phone);
    const ne = normalizeEmail(email);
    if (!np && !ne) return null;

    // Fast path: exact-variant + case-insensitive email match at the DB layer.
    const or: Prisma.CandidateProfileWhereInput[] = [];
    if (np) {
      const intl = np.startsWith('0') ? `+84${np.slice(1)}` : np;
      const variants = [...new Set([phone?.trim() ?? '', np, intl].filter((v) => v !== ''))];
      or.push({ phone: { in: variants } });
    }
    if (ne) {
      or.push({ email: { equals: (email ?? '').trim(), mode: 'insensitive' } });
    }

    const candidates = await this.prisma.candidateProfile.findMany({ where: { OR: or } });
    for (const c of candidates) {
      if (np && normalizePhone(c.phone) === np) return c;
      if (ne && normalizeEmail(c.email) === ne) return c;
    }

    // Fallback: a stored phone formatted differently (spaces/dots/dashes) won't
    // match the exact-variant `in` filter above, so it would slip past dedup.
    // Re-check by normalizing every stored phone in app. Scoped to rows that
    // actually have a phone and bounded in columns; dedup only runs on
    // create/promote (low frequency) so this is acceptable for the CRM size.
    if (np) {
      const withPhone = await this.prisma.candidateProfile.findMany({
        where: { phone: { not: null } },
        select: { id: true, phone: true },
      });
      const hit = withPhone.find((c) => normalizePhone(c.phone) === np);
      if (hit) {
        return this.prisma.candidateProfile.findUnique({ where: { id: hit.id } });
      }
    }
    return null;
  }

  async create(
    input: CreateCandidateInput,
    _actor: AuthInfo,
    options: { allowDuplicate?: boolean } = {},
  ): Promise<CandidateProfile> {
    if (blank(input.fullName)) {
      throw new ValidationError('fullName is required', 'FULL_NAME_REQUIRED');
    }
    if (blank(input.phone) && blank(input.email)) {
      throw new ValidationError('At least one of phone or email is required', 'CONTACT_REQUIRED');
    }
    this.validateOptionalEnums(input);
    const dob = parseDob(input.dob);

    // Dedup: by default consultants cannot create a second candidate for the
    // same normalized phone OR email. Pass { allowDuplicate: true } to override.
    if (!options.allowDuplicate) {
      const dup = await this.findDuplicate(input.phone, input.email);
      if (dup) {
        throw new ConflictError(
          `A candidate already exists with the same phone/email (id ${dup.id})`,
          'CANDIDATE_DUPLICATE',
        );
      }
    }

    const data: Prisma.CandidateProfileCreateInput = {
      fullName: input.fullName as string,
      phone: input.phone ?? null,
      email: input.email ?? null,
      dob: dob ?? null,
      gender: input.gender ?? '',
      hometown: input.hometown ?? '',
      education: input.education ?? '',
      currentJob: input.currentJob ?? '',
      desiredMarket: this.optionalMarket(input.desiredMarket),
      desiredIndustry: input.desiredIndustry ?? '',
      desiredVisaType: this.optionalVisa(input.desiredVisaType),
      japaneseLevel: input.japaneseLevel ?? 'NONE',
      otherLanguage: input.otherLanguage ?? '',
      stage: 'NEW',
      assignedTo: input.assignedTo ?? null,
      note: input.note ?? null,
      source: input.source ?? '',
    };
    if (input.leadId) data.leadId = input.leadId;
    if (input.branchId) data.branch = { connect: { id: input.branchId } };
    if (input.matchedJobOrderId) data.matchedJobOrder = { connect: { id: input.matchedJobOrderId } };

    return this.prisma.candidateProfile.create({ data });
  }

  async promoteFromLead(
    leadId: string,
    extra: PromoteFromLeadExtra,
    _actor: AuthInfo,
  ): Promise<CandidateProfile> {
    const lead = await this.prisma.lead.findUnique({ where: { leadId } });
    if (!lead) {
      throw new NotFoundError('Lead not found');
    }
    const existing = await this.prisma.candidateProfile.findUnique({ where: { leadId } });
    if (existing) {
      throw new ConflictError(
        `A candidate already exists for lead ${leadId}`,
        'CANDIDATE_ALREADY_EXISTS',
      );
    }
    // Also reject if a candidate already exists for this person's phone/email,
    // even when promoted from a different lead — don't create a second profile
    // for the same human.
    const dup = await this.findDuplicate(lead.phone, lead.email);
    if (dup) {
      throw new ConflictError(
        `A candidate already exists with the same phone/email (id ${dup.id})`,
        'CANDIDATE_DUPLICATE',
      );
    }
    this.validateOptionalEnums(extra);

    const fullName = !blank(extra.fullName)
      ? (extra.fullName as string)
      : (lead.name ?? '').trim();
    if (blank(fullName)) {
      throw new ValidationError('fullName is required', 'FULL_NAME_REQUIRED');
    }

    const data: Prisma.CandidateProfileCreateInput = {
      leadId,
      fullName,
      phone: lead.phone ?? null,
      email: lead.email ?? null,
      gender: extra.gender ?? '',
      hometown: extra.hometown ?? '',
      education: extra.education ?? '',
      currentJob: extra.currentJob ?? '',
      desiredMarket: this.optionalMarket(extra.desiredMarket),
      desiredIndustry: extra.desiredIndustry ?? '',
      desiredVisaType: this.optionalVisa(extra.desiredVisaType),
      japaneseLevel: extra.japaneseLevel ?? 'NONE',
      otherLanguage: extra.otherLanguage ?? '',
      stage: 'NEW',
      assignedTo: extra.assignedTo ?? lead.assignedTo ?? null,
      note: extra.note ?? null,
      source: lead.source,
    };
    if (extra.branchId) data.branch = { connect: { id: extra.branchId } };

    return this.prisma.candidateProfile.create({ data });
  }

  async get(id: string, actor: AuthInfo): Promise<CandidateProfile & { history: unknown[] }> {
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id } });
    if (!candidate) {
      throw new NotFoundError('Candidate not found');
    }
    // SALES may only access its own assigned candidates (mirrors LeadService).
    // Enforced here too because an UNASSIGNED candidate (assignedTo null) would
    // otherwise bypass the route guard, whose ownerUserId would be undefined.
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    const history = await this.prisma.candidateStageHistory.findMany({
      where: { candidateId: id },
      orderBy: { changedAt: 'desc' },
    });
    return { ...candidate, history };
  }

  async list(
    filter: CandidateListFilter,
    page: number,
    limit: number,
    actor: AuthInfo,
  ): Promise<CandidateListResult> {
    const where = this.buildListWhere(filter, actor);

    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;

    const [items, total] = await Promise.all([
      this.prisma.candidateProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.candidateProfile.count({ where }),
    ]);
    return { items, total, page: safePage, limit: safeLimit };
  }

  /**
   * Full-text-ish candidate search. Same shape/scoping as `list`, exposed as a
   * dedicated method so the search route reads clearly. `q` matches (case
   * insensitive) over fullName/phone/email.
   */
  async search(
    filter: CandidateListFilter,
    page: number,
    limit: number,
    actor: AuthInfo,
  ): Promise<CandidateListResult> {
    return this.list(filter, page, limit, actor);
  }

  /** Build the Prisma where-clause shared by list/search, incl. SALES scoping. */
  private buildListWhere(
    filter: CandidateListFilter,
    actor: AuthInfo,
  ): Prisma.CandidateProfileWhereInput {
    const where: Prisma.CandidateProfileWhereInput = {};

    // stageIn (comma list) takes precedence over a single stage when present.
    if (filter.stageIn !== undefined && filter.stageIn.trim() !== '') {
      const stages = filter.stageIn
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const s of stages) {
        if (!isCandidateStage(s)) {
          throw new ValidationError(`Invalid stage: ${String(s)}`, 'INVALID_STAGE');
        }
      }
      if (stages.length > 0) {
        where.stage = { in: stages as CandidateStage[] };
      }
    } else if (filter.stage !== undefined) {
      if (!isCandidateStage(filter.stage)) {
        throw new ValidationError(`Invalid stage: ${String(filter.stage)}`, 'INVALID_STAGE');
      }
      where.stage = filter.stage;
    }

    if (filter.desiredMarket !== undefined) {
      if (!isRecruitmentMarket(filter.desiredMarket)) {
        throw new ValidationError(
          `Invalid desiredMarket: ${String(filter.desiredMarket)}`,
          'INVALID_DESIRED_MARKET',
        );
      }
      where.desiredMarket = filter.desiredMarket;
    }
    if (filter.desiredVisaType !== undefined) {
      if (!isVisaType(filter.desiredVisaType)) {
        throw new ValidationError(
          `Invalid desiredVisaType: ${String(filter.desiredVisaType)}`,
          'INVALID_DESIRED_VISA_TYPE',
        );
      }
      where.desiredVisaType = filter.desiredVisaType;
    }
    if (filter.japaneseLevel !== undefined && filter.japaneseLevel !== '') {
      where.japaneseLevel = filter.japaneseLevel;
    }
    if (filter.assignedTo !== undefined) where.assignedTo = filter.assignedTo;
    if (filter.branchId !== undefined) where.branchId = filter.branchId;

    if (filter.q !== undefined && filter.q.trim() !== '') {
      const q = filter.q.trim();
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    // SALES sees only its own assigned candidates (mirrors LeadService scoping).
    if (actor.role === 'SALES') {
      where.assignedTo = actor.userId;
    }

    return where;
  }

  async update(id: string, input: UpdateCandidateInput, actor: AuthInfo): Promise<CandidateProfile> {
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id } });
    if (!candidate) {
      throw new NotFoundError('Candidate not found');
    }
    // SALES may only update its own assigned candidates (mirrors LeadService;
    // guards the unassigned-candidate gap the route-level owner check misses).
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    this.validateOptionalEnums(input);
    const dob = parseDob(input.dob);

    const data: Prisma.CandidateProfileUpdateInput = {};
    let stageChanged = false;
    const previousStage = candidate.stage as CandidateStage;
    let newStage: CandidateStage = previousStage;

    if (input.stage !== undefined && input.stage !== candidate.stage) {
      if (!isCandidateStage(input.stage)) {
        throw new ValidationError(`Invalid stage: ${String(input.stage)}`, 'INVALID_STAGE');
      }
      const transition = candidateTransition(previousStage, input.stage);
      if (!transition.ok) {
        // Illegal transition: no fields applied, no history appended.
        throw new ConflictError(
          `Illegal candidate stage transition ${candidate.stage} -> ${input.stage}`,
          'ILLEGAL_TRANSITION',
        );
      }
      newStage = transition.status;
      data.stage = newStage;
      stageChanged = true;
    }

    if (input.fullName !== undefined) {
      if (blank(input.fullName)) {
        throw new ValidationError('fullName is required', 'FULL_NAME_REQUIRED');
      }
      data.fullName = input.fullName;
    }
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.email !== undefined) data.email = input.email;
    if (dob !== undefined) data.dob = dob;
    if (input.gender !== undefined) data.gender = input.gender;
    if (input.hometown !== undefined) data.hometown = input.hometown;
    if (input.education !== undefined) data.education = input.education;
    if (input.currentJob !== undefined) data.currentJob = input.currentJob;
    if (input.desiredMarket !== undefined) data.desiredMarket = this.optionalMarket(input.desiredMarket);
    if (input.desiredIndustry !== undefined) data.desiredIndustry = input.desiredIndustry;
    if (input.desiredVisaType !== undefined) data.desiredVisaType = this.optionalVisa(input.desiredVisaType);
    if (input.japaneseLevel !== undefined) data.japaneseLevel = input.japaneseLevel;
    if (input.otherLanguage !== undefined) data.otherLanguage = input.otherLanguage;
    if (input.note !== undefined) data.note = input.note;
    if (input.assignedTo !== undefined) data.assignedTo = input.assignedTo;
    if (input.branchId !== undefined) {
      data.branch = input.branchId ? { connect: { id: input.branchId } } : { disconnect: true };
    }
    if (input.matchedJobOrderId !== undefined) {
      data.matchedJobOrder = input.matchedJobOrderId
        ? { connect: { id: input.matchedJobOrderId } }
        : { disconnect: true };
    }
    data.updatedAt = new Date();

    const updated = await this.prisma.candidateProfile.update({ where: { id }, data });

    if (stageChanged) {
      await this.prisma.candidateStageHistory.create({
        data: {
          candidateId: id,
          previousStage,
          newStage,
          note: input.note ?? null,
          actor: actor.userId,
          changedAt: new Date(),
        },
      });
      await this.emitStageChange(updated, previousStage, newStage);
      // Central oversight emit point (Req 7.2, 7.4, 7.6): one ActivityLog + one
      // Notification per ADMIN. Best-effort (swallows its own errors), called
      // after the stage change is committed; reuses previousStage/newStage.
      await this.oversight?.record({
        actorUserId: actor.userId,
        action: 'CANDIDATE_STAGE_CHANGED',
        targetType: 'candidate',
        targetId: id,
        detail: { previousStage, newStage },
      });
    }

    return updated;
  }

  async matchToJobOrder(
    candidateId: string,
    jobOrderId: string,
    actor: AuthInfo,
  ): Promise<CandidateProfile> {
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: candidateId } });
    if (!candidate) {
      throw new NotFoundError('Candidate not found');
    }
    // SALES may only act on its own assigned candidates (mirrors LeadService).
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
    const jobOrder = await this.prisma.jobOrder.findUnique({ where: { id: jobOrderId } });
    if (!jobOrder) {
      throw new NotFoundError('Job order not found');
    }

    const previousStage = candidate.stage as CandidateStage;
    const transition = candidateTransition(previousStage, 'MATCHED');
    if (!transition.ok) {
      throw new ConflictError(
        `Cannot match candidate from stage ${candidate.stage}`,
        'ILLEGAL_TRANSITION',
      );
    }

    const updated = await this.prisma.candidateProfile.update({
      where: { id: candidateId },
      data: {
        matchedJobOrder: { connect: { id: jobOrderId } },
        stage: 'MATCHED',
        updatedAt: new Date(),
      },
    });

    await this.prisma.candidateStageHistory.create({
      data: {
        candidateId,
        previousStage,
        newStage: 'MATCHED',
        note: `Matched to job order ${jobOrder.code}`,
        actor: actor.userId,
        changedAt: new Date(),
      },
    });
    await this.emitStageChange(updated, previousStage, 'MATCHED');
    // Central oversight emit point (Req 7.2, 7.4, 7.6): one ActivityLog + one
    // Notification per ADMIN. Best-effort, after the stage change is committed.
    await this.oversight?.record({
      actorUserId: actor.userId,
      action: 'CANDIDATE_STAGE_CHANGED',
      targetType: 'candidate',
      targetId: candidateId,
      detail: { previousStage, newStage: 'MATCHED' },
    });

    return updated;
  }

  async stats(
    groupBy: string,
    actor: AuthInfo,
  ): Promise<{ groupBy: CandidateStatGroupBy; buckets: Array<{ key: string; count: number }> }> {
    if (groupBy !== 'stage' && groupBy !== 'desiredMarket' && groupBy !== 'branchId') {
      throw new ValidationError(`Invalid groupBy: ${groupBy}`, 'INVALID_GROUP_BY');
    }
    const where: Prisma.CandidateProfileWhereInput = {};
    if (actor.role === 'SALES') {
      where.assignedTo = actor.userId;
    }

    // groupBy field is validated above; cast avoids Prisma's heavy conditional generics.
    const grouped = (await (this.prisma.candidateProfile.groupBy as unknown as (
      args: unknown,
    ) => Promise<unknown[]>)({
      by: [groupBy],
      where,
      _count: { _all: true },
    })) as Array<Record<string, unknown> & { _count: { _all: number } }>;

    const buckets = grouped.map((g) => ({
      key: g[groupBy] === null || g[groupBy] === undefined ? '' : String(g[groupBy]),
      count: g._count._all,
    }));
    return { groupBy, buckets };
  }

  async delete(id: string, _actor: AuthInfo): Promise<void> {
    // RBAC (ADMIN-only delete; SALES 403) is enforced at the route layer.
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id } });
    if (!candidate) {
      throw new NotFoundError('Candidate not found');
    }
    await this.prisma.candidateProfile.delete({ where: { id } });
  }
}

/** Re-export the canonical stage list for convenience. */
export { CANDIDATE_STAGES };
