/**
 * Review_Service — preview gate, approve, and reject (Content Pipeline Req 10).
 *
 * Approve/reject change status only when a preview has been presented and the
 * draft is in DRAFT:
 *   - not previewed -> 409 PREVIEW_REQUIRED
 *   - non-DRAFT     -> 409 (illegal transition)
 *   - approve       -> DRAFT->APPROVED via the Content_State_Machine
 *   - reject        -> requires a non-blank reason (400), stores it, returns to DRAFT
 */
import type { ContentDraft, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../infra/errors';
import { contentTransition } from './stateMachine';
import type { ContentStatus } from './stateMachine';
import type { EventBus } from '../infra/events';

export class ReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventBus?: EventBus,
  ) {}

  /** Publish a draft status-change event (best-effort; never blocks the write). */
  private async emitStatus(draft: ContentDraft): Promise<void> {
    if (!this.eventBus) return;
    try {
      await this.eventBus.publish({
        topic: 'draft',
        type: 'status_changed',
        payload: { id: draft.id, status: draft.status },
      });
    } catch {
      // Non-critical; swallow.
    }
  }

  /** Present a draft for review and mark the preview as presented (Req 10.1). */
  async preview(id: string): Promise<ContentDraft> {
    const draft = await this.requireDraft(id);
    if (draft.previewPresented) return draft;
    return this.prisma.contentDraft.update({
      where: { id },
      data: { previewPresented: true },
    });
  }

  /**
   * Approve a draft (Req 10.2, 10.4): requires a presented preview and DRAFT
   * status; transitions DRAFT->APPROVED via the state machine.
   */
  async approve(id: string): Promise<ContentDraft> {
    const draft = await this.requireDraft(id);
    this.assertPreviewed(draft.previewPresented);

    const result = contentTransition(draft.status as ContentStatus, 'APPROVED');
    if (!result.ok) {
      throw new ConflictError(
        `Cannot approve a draft in status ${draft.status}`,
        'ILLEGAL_TRANSITION',
      );
    }
    const approved = await this.prisma.contentDraft.update({
      where: { id },
      data: { status: 'APPROVED' },
    });
    await this.emitStatus(approved);
    return approved;
  }

  /**
   * Reject a draft (Req 10.5, 10.6): requires a presented preview, DRAFT status,
   * and a non-blank reason. Records DRAFT->REJECTED then REJECTED->DRAFT,
   * persisting the reason and leaving the draft in DRAFT.
   */
  async reject(id: string, reason: string): Promise<ContentDraft> {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new ValidationError('A rejection reason is required', 'REJECT_REASON_REQUIRED');
    }
    const draft = await this.requireDraft(id);
    this.assertPreviewed(draft.previewPresented);

    // Validate the lifecycle via the state machine: DRAFT->REJECTED then back.
    const toRejected = contentTransition(draft.status as ContentStatus, 'REJECTED');
    if (!toRejected.ok) {
      throw new ConflictError(
        `Cannot reject a draft in status ${draft.status}`,
        'ILLEGAL_TRANSITION',
      );
    }
    const backToDraft = contentTransition('REJECTED', 'DRAFT');
    if (!backToDraft.ok) {
      throw new ConflictError('Cannot return draft to DRAFT', 'ILLEGAL_TRANSITION');
    }

    const rejected = await this.prisma.contentDraft.update({
      where: { id },
      data: { status: 'DRAFT', rejectionReason: reason.trim() },
    });
    await this.emitStatus(rejected);
    return rejected;
  }

  private assertPreviewed(previewPresented: boolean): void {
    if (!previewPresented) {
      throw new ConflictError('Preview must be presented before this action', 'PREVIEW_REQUIRED');
    }
  }

  private async requireDraft(id: string): Promise<ContentDraft> {
    const draft = await this.prisma.contentDraft.findUnique({ where: { id } });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }
    return draft;
  }
}
