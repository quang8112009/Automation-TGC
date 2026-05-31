/**
 * Draft_Manager — draft listing, detail, the DRAFT-only edit guard, and the
 * two-step delete (Content Pipeline Req 9).
 *
 * Edits persist only while a draft is in DRAFT status; a non-DRAFT edit is
 * rejected with HTTP 409 and leaves the draft unchanged. Deletion requires an
 * explicit confirmation step before the row is removed.
 */
import type { PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../infra/errors';

export interface DraftListItem {
  id: string;
  title: string;
  status: string;
}

export interface DraftListResult {
  items: DraftListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DraftDetail {
  id: string;
  title: string;
  body: string;
  status: string;
  ctas: string[];
}

export interface DraftEditInput {
  title?: string;
  body?: string;
  ctas?: string[];
}

export class DraftService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Paginated list returning id + title + status (Req 9.1). */
  async list(page: number, limit: number): Promise<DraftListResult> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;
    const [rows, total] = await Promise.all([
      this.prisma.contentDraft.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        select: { id: true, title: true, status: true },
      }),
      this.prisma.contentDraft.count(),
    ]);
    return {
      items: rows.map((r) => ({ id: r.id, title: r.title, status: r.status })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  /** Draft detail returning title/body/CTAs (Req 9.2); 404 if missing. */
  async get(id: string): Promise<DraftDetail> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id },
      include: { ctas: true },
    });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }
    return {
      id: draft.id,
      title: draft.title,
      body: draft.body,
      status: draft.status,
      ctas: draft.ctas.map((c) => c.ctaText),
    };
  }

  /**
   * Edit a draft (Req 9.3, 9.4): permitted only while status is DRAFT; a
   * non-DRAFT edit -> 409 with no change. Replaces CTAs when provided.
   */
  async edit(id: string, input: DraftEditInput): Promise<DraftDetail> {
    const draft = await this.prisma.contentDraft.findUnique({ where: { id } });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }
    if (draft.status !== 'DRAFT') {
      throw new ConflictError(
        `Cannot edit a draft in status ${draft.status}`,
        'DRAFT_NOT_EDITABLE',
      );
    }

    let ctas: string[] | undefined;
    if (input.ctas !== undefined) {
      ctas = input.ctas.map((c) => c.trim()).filter((c) => c.length > 0);
      if (ctas.length === 0) {
        throw new ValidationError('A draft must keep at least one CTA', 'DRAFT_CTA_REQUIRED');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.contentDraft.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        },
      });
      if (ctas !== undefined) {
        await tx.draftCta.deleteMany({ where: { draftId: id } });
        await tx.draftCta.createMany({ data: ctas.map((ctaText) => ({ draftId: id, ctaText })) });
      }
    });

    return this.get(id);
  }

  /** Step 1 of delete: signal that an explicit confirmation is required (Req 9.5). */
  async requestDelete(id: string): Promise<{ confirmationRequired: true; id: string }> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }
    return { confirmationRequired: true, id };
  }

  /** Step 2 of delete: remove the draft (and cascade CTAs/media) (Req 9.6). */
  async confirmDelete(id: string): Promise<{ deleted: true; id: string }> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }
    await this.prisma.contentDraft.delete({ where: { id } });
    return { deleted: true, id };
  }
}
