/**
 * DocumentChecklistService — candidate document-checklist I/O over the
 * `DocumentChecklistItem` model (Requirements 11.3, 12.2, 12.3, 13.1, 13.2,
 * 13.3).
 *
 * Initializes a per-market default checklist from `documentCatalog`, lists
 * items with a divide-by-zero-safe completion metric (`completion.ts`), adds
 * ad-hoc CUSTOM items, and updates submission status against the four-value
 * enum. Pure validation lives in `./validation`; the completion formula in
 * `./completion`; the catalog in `./documentCatalog`.
 *
 * RBAC / SALES assigned-only scoping and route wiring are handled at the route
 * layer (task 7.8) via `candidateTargetById` + `rbacGuard`. The service accepts
 * the resolved `actor` so the route can pass it through; it deliberately does
 * not re-implement authorization here.
 */
import type {
  DocumentChecklistItem,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import type { AuthInfo } from '../../http/authMiddleware';
import type { OversightService } from '../../oversight/oversightService';
import { NotFoundError } from '../../infra/errors';
import { defaultDocsForMarket } from './documentCatalog';
import type { DocSubmissionStatus } from './documentCatalog';
import { completionMetric } from './completion';
import { assertNonBlankLabel, assertValidStatus } from './validation';

/** Input for adding a candidate-specific custom checklist item. */
export interface AddCustomDocInput {
  label: string;
  required?: boolean;
}

/** Result of listing a candidate's checklist: items + completion metric. */
export interface ChecklistListResult {
  items: DocumentChecklistItem[];
  completion: number | 'INSUFFICIENT_DATA';
}

/**
 * Derive a stable, machine-readable type code for a CUSTOM item from its label.
 * Strips Vietnamese diacritics (NFD + combining-mark removal, plus đ/Đ which
 * NFD does not decompose), uppercases, and collapses non-alphanumerics to
 * underscores. Falls back to the generic `CUSTOM` code when nothing remains.
 */
function customTypeCode(label: string): string {
  const slug = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug ? `CUSTOM_${slug}` : 'CUSTOM';
}

export class DocumentChecklistService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly oversight?: OversightService,
  ) {}

  /** Load a candidate or throw a typed 404. */
  private async getCandidateOrThrow(
    candidateId: string,
  ): Promise<{ id: string; desiredMarket: string | null }> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
      select: { id: true, desiredMarket: true },
    });
    if (!candidate) {
      throw new NotFoundError('Candidate not found');
    }
    return { id: candidate.id, desiredMarket: candidate.desiredMarket ?? null };
  }

  /**
   * Initialize a candidate's checklist from the default catalog for their
   * `desiredMarket` (falling back to the `OTHER` set when null/unknown), seeding
   * each item with source `DEFAULT`. Idempotent guard: if the candidate already
   * has DEFAULT items, returns them as-is instead of duplicating.
   * (Requirements 12.2, 12.3)
   */
  async initForCandidate(
    candidateId: string,
    _actor: AuthInfo,
  ): Promise<DocumentChecklistItem[]> {
    const candidate = await this.getCandidateOrThrow(candidateId);

    const existing = await this.prisma.documentChecklistItem.findMany({
      where: { candidateId, source: 'DEFAULT' },
      orderBy: { createdAt: 'asc' },
    });
    if (existing.length > 0) {
      return existing;
    }

    const docs = defaultDocsForMarket(candidate.desiredMarket);
    // Promise.all preserves input order in the returned array, so the created
    // rows come back in catalog order regardless of resolution timing.
    const created = await Promise.all(
      docs.map((doc) =>
        this.prisma.documentChecklistItem.create({
          data: {
            candidateId,
            type: doc.type,
            label: doc.label,
            required: doc.required,
            source: 'DEFAULT',
            status: 'PENDING',
          },
        }),
      ),
    );
    return created;
  }

  /**
   * List a candidate's checklist items together with the completion metric
   * (`completionMetric`, which is divide-by-zero safe and yields
   * `'INSUFFICIENT_DATA'` when there are no required items). (Requirement 13.4)
   */
  async list(candidateId: string, _actor: AuthInfo): Promise<ChecklistListResult> {
    const items = await this.prisma.documentChecklistItem.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'asc' },
    });
    return { items, completion: completionMetric(items) };
  }

  /**
   * Add a candidate-specific CUSTOM checklist item. The label must be non-blank
   * after trimming, otherwise a `ValidationError` (HTTP 400) is thrown.
   * `required` defaults to `true`. (Requirements 13.1, 13.2)
   */
  async addCustom(
    candidateId: string,
    input: AddCustomDocInput,
    _actor: AuthInfo,
  ): Promise<DocumentChecklistItem> {
    const label = assertNonBlankLabel(input.label);
    await this.getCandidateOrThrow(candidateId);

    const data: Prisma.DocumentChecklistItemCreateInput = {
      candidate: { connect: { id: candidateId } },
      type: customTypeCode(label),
      label,
      required: input.required ?? true,
      source: 'CUSTOM',
      status: 'PENDING',
    };
    return this.prisma.documentChecklistItem.create({ data });
  }

  /**
   * Update an item's submission status. Only the four valid enum values are
   * accepted (anything else → `ValidationError` / HTTP 400). When the new status
   * is `SUBMITTED`, the submission timestamp is recorded. When the new status is
   * `VERIFIED`, the transition is funnelled through the central oversight emit
   * point AFTER the update commits (failure-isolated). (Requirements 11.3, 13.3,
   * 7.1, 7.4, 7.6)
   */
  async updateStatus(
    itemId: string,
    status: unknown,
    actor: AuthInfo,
  ): Promise<DocumentChecklistItem> {
    const nextStatus: DocSubmissionStatus = assertValidStatus(status);

    const item = await this.prisma.documentChecklistItem.findUnique({
      where: { id: itemId },
    });
    if (!item) {
      throw new NotFoundError('Document checklist item not found');
    }

    const data: Prisma.DocumentChecklistItemUpdateInput = { status: nextStatus };
    if (nextStatus === 'SUBMITTED') {
      data.submittedAt = new Date();
    }

    const updated = await this.prisma.documentChecklistItem.update({
      where: { id: itemId },
      data,
    });

    // After the business action commits, funnel the VERIFIED transition through
    // the central oversight emit point (1 ActivityLog + N Notifications + 1
    // realtime event). `record` is failure-isolated, so awaiting it can never
    // roll back or break the already-committed update (Req 7.1, 7.4, 7.6).
    if (nextStatus === 'VERIFIED') {
      await this.oversight?.record({
        actorUserId: actor.userId,
        action: 'DOCUMENT_VERIFIED',
        targetType: 'document',
        targetId: itemId,
        detail: { candidateId: updated.candidateId, type: updated.type },
      });
    }

    return updated;
  }
}
