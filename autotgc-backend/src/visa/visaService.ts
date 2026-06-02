/**
 * VisaService — I/O + lifecycle for per-candidate visa cases (Smart Checklist)
 * and their logistics plan. The pure catalog (`visaCatalog`) decides WHICH tasks
 * and deadlines; the pure planner (`logisticsPlanner`) decides default logistics.
 * This service persists VisaCase / VisaTask / LogisticsPlan rows and enforces
 * SALES assigned-only scoping via the owning CandidateProfile.assignedTo.
 */
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError, ValidationError } from '../infra/errors';
import { checklistFor, withDeadlines, normalizeCountry } from './visaCatalog';
import { suggestLogistics } from './logisticsPlanner';

const VISA_TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'] as const;
type VisaTaskStatusValue = (typeof VISA_TASK_STATUSES)[number];

function isTaskStatus(v: unknown): v is VisaTaskStatusValue {
  return typeof v === 'string' && (VISA_TASK_STATUSES as readonly string[]).includes(v);
}

export interface CreateVisaCaseInput {
  candidateId?: string;
  country?: string;
  visaType?: string;
  targetIntakeDate?: string;
  submissionDeadline?: string;
}

export class VisaService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Resolve a candidate's assignedTo for SALES scoping (404 if missing). */
  private async assertCandidateAccess(candidateId: string, actor: AuthInfo): Promise<void> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
      select: { assignedTo: true },
    });
    if (!candidate) {
      throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');
    }
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }
  }

  /** Resolve a case + enforce candidate-scoped access. */
  private async requireCase(id: string, actor: AuthInfo): Promise<{ id: string; candidateId: string; country: string }> {
    const row = await this.prisma.visaCase.findUnique({
      where: { id },
      select: { id: true, candidateId: true, country: true },
    });
    if (!row) {
      throw new NotFoundError('Visa case not found', 'VISA_CASE_NOT_FOUND');
    }
    await this.assertCandidateAccess(row.candidateId, actor);
    return row;
  }

  /**
   * Create a visa case for a candidate + country and auto-generate the smart
   * checklist (tasks with computed deadlines). Idempotent-ish: a case is created
   * each call, but tasks are seeded from the catalog once at creation.
   */
  async createCase(input: CreateVisaCaseInput, actor: AuthInfo): Promise<unknown> {
    const candidateId = (input.candidateId ?? '').trim();
    const country = normalizeCountry(input.country);
    if (!candidateId) throw new ValidationError('candidateId is required', 'VISA_CANDIDATE_REQUIRED');
    if (!country) throw new ValidationError('country is required', 'VISA_COUNTRY_REQUIRED');
    await this.assertCandidateAccess(candidateId, actor);

    const targetIntakeDate = this.parseDate(input.targetIntakeDate);
    const submissionDeadline = this.parseDate(input.submissionDeadline);

    const templates = checklistFor(country);
    const dated = withDeadlines(templates, targetIntakeDate ?? null);

    const created = await this.prisma.visaCase.create({
      data: {
        candidateId,
        country,
        visaType: input.visaType ?? '',
        status: 'OPEN',
        targetIntakeDate: targetIntakeDate ?? null,
        submissionDeadline: submissionDeadline ?? null,
        aiGenerated: true,
        createdBy: actor.userId,
        tasks: {
          create: dated.map((t) => ({
            code: t.code,
            label: t.label,
            category: t.category,
            required: t.required,
            status: 'PENDING',
            dueAt: t.dueAt,
            source: 'DEFAULT',
          })),
        },
      },
      include: { tasks: { orderBy: { dueAt: 'asc' } } },
    });
    return created;
  }

  /** Get a case with tasks + logistics (scoped). */
  async getCase(id: string, actor: AuthInfo): Promise<unknown> {
    await this.requireCase(id, actor);
    return this.prisma.visaCase.findUnique({
      where: { id },
      include: { tasks: { orderBy: { dueAt: 'asc' } }, logistics: true },
    });
  }

  /** List a candidate's visa cases (scoped). */
  async listForCandidate(candidateId: string, actor: AuthInfo): Promise<unknown> {
    await this.assertCandidateAccess(candidateId, actor);
    const items = await this.prisma.visaCase.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      include: { tasks: { orderBy: { dueAt: 'asc' } } },
    });
    return { items, total: items.length };
  }

  /** Update a single task's status / due date / note (scoped via its case). */
  async updateTask(
    taskId: string,
    patch: { status?: unknown; dueAt?: unknown; note?: unknown },
    actor: AuthInfo,
  ): Promise<unknown> {
    const task = await this.prisma.visaTask.findUnique({
      where: { id: taskId },
      select: { id: true, caseId: true },
    });
    if (!task) throw new NotFoundError('Visa task not found', 'VISA_TASK_NOT_FOUND');
    await this.requireCase(task.caseId, actor);

    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      if (!isTaskStatus(patch.status)) {
        throw new ValidationError('Invalid task status', 'VISA_TASK_STATUS_INVALID');
      }
      data.status = patch.status;
    }
    if (patch.dueAt !== undefined) {
      const d = this.parseDate(typeof patch.dueAt === 'string' ? patch.dueAt : undefined);
      data.dueAt = d ?? null;
    }
    if (patch.note !== undefined && typeof patch.note === 'string') data.note = patch.note;

    return this.prisma.visaTask.update({ where: { id: taskId }, data });
  }

  /** Add a custom task to a case (scoped). */
  async addTask(
    caseId: string,
    input: { label?: string; category?: string; required?: boolean; dueAt?: string },
    actor: AuthInfo,
  ): Promise<unknown> {
    await this.requireCase(caseId, actor);
    const label = (input.label ?? '').trim();
    if (!label) throw new ValidationError('label is required', 'VISA_TASK_LABEL_REQUIRED');
    const category = this.normalizeCategory(input.category);
    return this.prisma.visaTask.create({
      data: {
        caseId,
        code: `CUSTOM_${Date.now()}`,
        label,
        category,
        required: input.required ?? false,
        status: 'PENDING',
        dueAt: this.parseDate(input.dueAt) ?? null,
        source: 'CUSTOM',
      },
    });
  }

  /**
   * Build (or refresh) the logistics plan for a case from the pure planner's
   * country-aware defaults, then upsert it. Any field can later be overridden
   * via `updateLogistics`.
   */
  async generateLogistics(caseId: string, actor: AuthInfo): Promise<unknown> {
    const row = await this.requireCase(caseId, actor);
    const suggestion = suggestLogistics(row.country);
    const plan = await this.prisma.logisticsPlan.upsert({
      where: { caseId },
      create: {
        caseId,
        insuranceType: suggestion.insuranceType,
        housingType: suggestion.housingType,
        pickupService: suggestion.recommendPickup ? 'TBD' : '',
        aiGenerated: true,
        notes: [...suggestion.notes, '', 'Cần chuẩn bị:', ...suggestion.checklist].join('\n'),
      },
      update: {
        insuranceType: suggestion.insuranceType,
        housingType: suggestion.housingType,
        aiGenerated: true,
        notes: [...suggestion.notes, '', 'Cần chuẩn bị:', ...suggestion.checklist].join('\n'),
      },
    });
    return { plan, suggestion };
  }

  /** Override logistics plan fields (scoped). */
  async updateLogistics(caseId: string, patch: Record<string, unknown>, actor: AuthInfo): Promise<unknown> {
    await this.requireCase(caseId, actor);
    const data: Record<string, unknown> = {};
    for (const key of ['insuranceType', 'pickupService', 'housingType', 'notes'] as const) {
      if (typeof patch[key] === 'string') data[key] = patch[key];
    }
    for (const key of ['flightInfo', 'insuranceInfo', 'pickupInfo', 'housingInfo'] as const) {
      if (patch[key] && typeof patch[key] === 'object') data[key] = patch[key] as object;
    }
    return this.prisma.logisticsPlan.upsert({
      where: { caseId },
      create: { caseId, ...data },
      update: data,
    });
  }

  private normalizeCategory(v: unknown): 'DOCUMENT' | 'INSURANCE' | 'FLIGHT' | 'HOUSING' | 'PICKUP' | 'FEE' | 'OTHER' {
    const allowed = ['DOCUMENT', 'INSURANCE', 'FLIGHT', 'HOUSING', 'PICKUP', 'FEE', 'OTHER'];
    return typeof v === 'string' && allowed.includes(v)
      ? (v as 'DOCUMENT')
      : 'OTHER';
  }

  private parseDate(v: string | undefined): Date | undefined {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
}
