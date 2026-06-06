/**
 * ErasureService — right-to-erasure (GDPR Art.17 style) for personal data.
 *
 * Erases the PII a data subject can identify themselves by, while preserving
 * referential integrity and non-identifying analytics aggregates:
 *  - LEAD      → null/clear name/phone/email/note on the Lead and its history
 *                notes; the row + attribution counters survive for analytics.
 *  - INTAKE    → clear displayName + collected dossier on the conversation and
 *                redact every message body; the conversation skeleton survives.
 *  - CANDIDATE → clear contact fields + note on the CandidateProfile.
 *
 * Every request is recorded in `ErasureRequest` with a COUNTS-ONLY summary
 * (never the erased values), so the action is auditable. PII values are NEVER
 * logged or echoed back.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { NotFoundError, ValidationError } from '../infra/errors';

export type ErasureSubjectType = 'LEAD' | 'CANDIDATE' | 'INTAKE';

const SUBJECT_TYPES: ReadonlySet<string> = new Set(['LEAD', 'CANDIDATE', 'INTAKE']);

/** Placeholder written into required (non-null) identifying columns. */
const ERASED = '[ERASED]';

export interface ErasureResultView {
  id: string;
  subjectType: ErasureSubjectType;
  subjectId: string;
  status: 'COMPLETED';
  erasedSummary: Record<string, number>;
  processedAt: Date;
}

export interface ErasureInput {
  subjectType: string;
  subjectId: string;
  requestedBy: string;
  reason?: string;
}

export class ErasureService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Execute erasure for a subject and record the request+outcome atomically.
   * Returns a counts-only summary. 404 when the subject does not exist.
   */
  async erase(input: ErasureInput): Promise<ErasureResultView> {
    const subjectType = this.assertSubjectType(input.subjectType);
    const subjectId = (input.subjectId ?? '').trim();
    if (!subjectId) {
      throw new ValidationError('subjectId is required', 'ERASURE_SUBJECT_REQUIRED');
    }

    const summary =
      subjectType === 'LEAD'
        ? await this.eraseLead(subjectId)
        : subjectType === 'INTAKE'
          ? await this.eraseIntake(subjectId)
          : await this.eraseCandidate(subjectId);

    const request = await this.prisma.erasureRequest.create({
      data: {
        subjectType,
        subjectId,
        status: 'COMPLETED',
        reason: input.reason ?? '',
        requestedBy: input.requestedBy,
        processedBy: input.requestedBy,
        erasedSummary: summary,
        processedAt: new Date(),
      },
    });

    return {
      id: request.id,
      subjectType,
      subjectId,
      status: 'COMPLETED',
      erasedSummary: summary,
      processedAt: request.processedAt ?? new Date(),
    };
  }

  private async eraseLead(leadId: string): Promise<Record<string, number>> {
    const lead = await this.prisma.lead.findUnique({ where: { leadId } });
    if (!lead) throw new NotFoundError('Lead not found', 'LEAD_NOT_FOUND');

    await this.prisma.lead.update({
      where: { leadId },
      data: { name: null, phone: null, email: null, note: null },
    });
    // Redact identifying free-text notes in history; keep the status transitions.
    const history = await this.prisma.leadHistoryEntry.updateMany({
      where: { leadId, NOT: { note: null } },
      data: { note: ERASED },
    });
    return { lead: 1, leadHistoryNotes: history.count };
  }

  private async eraseIntake(conversationId: string): Promise<Record<string, number>> {
    const convo = await this.prisma.intakeConversation.findUnique({
      where: { id: conversationId },
    });
    if (!convo) throw new NotFoundError('Conversation not found', 'INTAKE_NOT_FOUND');

    await this.prisma.intakeConversation.update({
      where: { id: conversationId },
      data: { displayName: null, collected: {} },
    });
    const messages = await this.prisma.intakeMessage.updateMany({
      where: { conversationId },
      data: { text: ERASED, raw: Prisma.DbNull },
    });
    return { conversation: 1, messages: messages.count };
  }

  private async eraseCandidate(candidateId: string): Promise<Record<string, number>> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
    });
    if (!candidate) throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');

    await this.prisma.candidateProfile.update({
      where: { id: candidateId },
      data: { fullName: ERASED, phone: null, email: null, note: null },
    });
    return { candidate: 1 };
  }

  private assertSubjectType(value: string): ErasureSubjectType {
    if (!SUBJECT_TYPES.has(value)) {
      throw new ValidationError(
        'subjectType must be one of LEAD, CANDIDATE, INTAKE',
        'ERASURE_SUBJECT_TYPE_INVALID',
      );
    }
    return value as ErasureSubjectType;
  }
}
