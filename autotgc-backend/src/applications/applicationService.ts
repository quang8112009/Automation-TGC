/**
 * ApplicationService — I/O + lifecycle for per-candidate program application
 * cases and the merged application/visa timeline
 * (study-abroad-ai-advisor-suite, Requirements 13 & 14).
 *
 * Mirrors `visa/visaService.ts`: the same SALES assigned-only candidate scoping
 * (via the owning `CandidateProfile.assignedTo`) and the same due-item seeding
 * via the pure `visaCatalog` (`checklistFor` + `withDeadlines`). The pure
 * `Timeline_Computer` (`timelineComputer.ts`) decides ordering; this service only
 * persists `ApplicationCase` / `ApplicationDueItem` rows and projects the
 * candidate's `ApplicationDueItem`s + `VisaTask`s into a single `DueItem[]`.
 *
 * _Requirements: 13.1, 13.3, 13.4, 14.1_
 */
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError, ValidationError } from '../infra/errors';
import { checklistFor, withDeadlines, normalizeCountry, hasCountryTemplate } from '../visa/visaCatalog';
import { computeTimeline, nextDue } from './timelineComputer';
import type { DueItem } from './types';
import type { OversightService } from '../oversight/oversightService';

/** Input for creating a program application case (Req 13.1). */
export interface CreateApplicationInput {
  /** Optional `DestinationProgram` this case applies to. */
  programId?: string;
  /** Human-readable intake label, e.g. "Fall 2025" (required). */
  intakeLabel: string;
  /** Target intake date; when absent due-item deadlines stay null (Req 13.4). */
  targetIntakeDate?: string;
  /** Country whose `visaCatalog` template seeds the due items (Req 13.3). */
  country?: string;
}

/** Result of computing a candidate's merged timeline (Req 14.1). */
export interface TimelineResult {
  /** Stable, set-preserving timeline ordering of all due items. */
  items: DueItem[];
  /** Earliest not-done item, or `null` when none remain (Req 14.7). */
  nextDue: DueItem | null;
}

export class ApplicationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly oversight?: OversightService,
  ) {}

  /**
   * Resolve a candidate's `assignedTo` for SALES scoping. Mirrors
   * `VisaService.assertCandidateAccess`: missing candidate → 404; a SALES actor
   * working a candidate they are not assigned to → 403.
   */
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

  /**
   * Create an `ApplicationCase` for a candidate and, when the case's country has
   * a `visaCatalog` template, seed its `ApplicationDueItem`s from
   * `checklistFor` + `withDeadlines` (Req 13.1, 13.3).
   *
   * The country is taken from `input.country` or, when absent, derived from the
   * linked `DestinationProgram`. When no target intake date is supplied, each
   * seeded due item keeps `dueAt = null` — no fabricated deadline (Req 13.4).
   *
   * @returns the created case including its due items ordered by `dueAt` asc.
   */
  async createCase(candidateId: string, input: CreateApplicationInput, actor: AuthInfo): Promise<unknown> {
    await this.assertCandidateAccess(candidateId, actor);

    const intakeLabel = (input.intakeLabel ?? '').trim();
    if (!intakeLabel) {
      throw new ValidationError('intakeLabel is required', 'APPLICATION_INTAKE_LABEL_REQUIRED');
    }

    const programId = input.programId?.trim() || undefined;
    const targetIntakeDate = this.parseDate(input.targetIntakeDate);
    const country = await this.resolveCountry(input.country, programId);

    // Only countries present in the catalog seed a checklist (Req 13.3). Unknown
    // countries create an empty case rather than fabricating items.
    const seed = hasCountryTemplate(country)
      ? withDeadlines(checklistFor(country), targetIntakeDate ?? null)
      : [];

    const created = await this.prisma.applicationCase.create({
      data: {
        candidateId,
        programId: programId ?? null,
        intakeLabel,
        targetIntakeDate: targetIntakeDate ?? null,
        status: 'PLANNING',
        createdBy: actor.userId,
        dueItems: seed.length
          ? {
              create: seed.map((t) => ({
                code: t.code,
                label: t.label,
                category: t.category,
                required: t.required,
                dueAt: t.dueAt, // null when no target intake date (Req 13.4)
                status: 'PENDING',
                done: false,
              })),
            }
          : undefined,
      },
      include: { dueItems: { orderBy: { dueAt: 'asc' } } },
    });
    return created;
  }

  /** List a candidate's application cases with their due items (scoped). */
  async listForCandidate(candidateId: string, actor: AuthInfo): Promise<unknown> {
    await this.assertCandidateAccess(candidateId, actor);
    const items = await this.prisma.applicationCase.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      include: { dueItems: { orderBy: { dueAt: 'asc' } } },
    });
    return { items, total: items.length };
  }

  /**
   * Merge the candidate's `ApplicationDueItem`s (across all `ApplicationCase`s)
   * and `VisaTask`s (across all `VisaCase`s) into a single `DueItem[]`, then run
   * the pure `computeTimeline` for a stable, set-preserving ordering (Req 14.1).
   *
   * A `VisaTask` is considered done iff its status is `DONE`; an
   * `ApplicationDueItem` uses its own `done` flag. `nextDue` is the earliest
   * not-done item (Req 14.7).
   */
  async timeline(candidateId: string, actor: AuthInfo): Promise<TimelineResult> {
    await this.assertCandidateAccess(candidateId, actor);

    const [dueRows, taskRows] = await Promise.all([
      this.prisma.applicationDueItem.findMany({
        where: { case: { candidateId } },
        select: { id: true, caseId: true, code: true, label: true, dueAt: true, done: true },
      }),
      this.prisma.visaTask.findMany({
        where: { case: { candidateId } },
        select: { id: true, caseId: true, code: true, label: true, dueAt: true, status: true },
      }),
    ]);

    const items: DueItem[] = [
      ...dueRows.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        caseType: 'APPLICATION' as const,
        code: r.code,
        label: r.label,
        dueAt: r.dueAt,
        done: r.done,
      })),
      ...taskRows.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        caseType: 'VISA' as const,
        code: r.code,
        label: r.label,
        dueAt: r.dueAt,
        done: r.status === 'DONE',
      })),
    ];

    const now = new Date();
    const ordered = computeTimeline(items, now);
    return { items: ordered, nextDue: nextDue(items, now) ?? null };
  }

  /** Derive the catalog country from explicit input or the linked program. */
  private async resolveCountry(country: string | undefined, programId: string | undefined): Promise<string> {
    const explicit = normalizeCountry(country);
    if (explicit) return explicit;
    if (!programId) return '';
    const program = await this.prisma.destinationProgram.findUnique({
      where: { id: programId },
      select: { country: true },
    });
    return normalizeCountry(program?.country);
  }

  /** Parse an optional date string, returning undefined for blank/invalid input. */
  private parseDate(v: string | undefined): Date | undefined {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
}
