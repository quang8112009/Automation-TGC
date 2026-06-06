/**
 * ConsentService — append-only consent ledger (security/privacy hardening).
 *
 * Records and reads data-subject consent for a (subjectType, subjectId, scope).
 * Consent is NEVER mutated in place: granting and withdrawing both append a new
 * `ConsentRecord` row, so the full history is preserved and auditable. The
 * EFFECTIVE consent for a (subject, scope) is the most recent row's action.
 *
 * Scopes:
 *  - DATA_PROCESSING — store + process personal data for consulting.
 *  - MARKETING       — send marketing / follow-up messages.
 *  - CROSS_BORDER_AI — transfer content to overseas AI providers (DeepSeek /
 *                      Gemini / VEO). Gate cross-border AI calls on this.
 */
import type { PrismaClient } from '@prisma/client';
import { ValidationError } from '../infra/errors';

export type ConsentSubjectType = 'LEAD' | 'CANDIDATE' | 'INTAKE';
export type ConsentScope = 'DATA_PROCESSING' | 'MARKETING' | 'CROSS_BORDER_AI';
export type ConsentAction = 'GRANTED' | 'WITHDRAWN';

const SUBJECT_TYPES: ReadonlySet<string> = new Set(['LEAD', 'CANDIDATE', 'INTAKE']);
const SCOPES: ReadonlySet<string> = new Set(['DATA_PROCESSING', 'MARKETING', 'CROSS_BORDER_AI']);

export interface ConsentRecordView {
  id: string;
  subjectType: ConsentSubjectType;
  subjectId: string;
  scope: ConsentScope;
  action: ConsentAction;
  source: string;
  note: string | null;
  actor: string;
  recordedAt: Date;
}

export interface RecordConsentInput {
  subjectType: string;
  subjectId: string;
  scope: string;
  action?: string;
  source?: string;
  note?: string | null;
  actor?: string;
}

export class ConsentService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Append a consent event (GRANTED by default). Validates the enums. */
  async record(input: RecordConsentInput): Promise<ConsentRecordView> {
    const subjectType = this.assertSubjectType(input.subjectType);
    const scope = this.assertScope(input.scope);
    const action: ConsentAction = input.action === 'WITHDRAWN' ? 'WITHDRAWN' : 'GRANTED';
    if (!input.subjectId || input.subjectId.trim().length === 0) {
      throw new ValidationError('subjectId is required', 'CONSENT_SUBJECT_REQUIRED');
    }
    const row = await this.prisma.consentRecord.create({
      data: {
        subjectType,
        subjectId: input.subjectId.trim(),
        scope,
        action,
        source: input.source ?? '',
        note: input.note ?? null,
        actor: input.actor ?? 'system',
      },
    });
    return this.toView(row);
  }

  /** Full consent history for a subject, newest first. */
  async history(subjectType: string, subjectId: string): Promise<ConsentRecordView[]> {
    const st = this.assertSubjectType(subjectType);
    const rows = await this.prisma.consentRecord.findMany({
      where: { subjectType: st, subjectId },
      orderBy: { recordedAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * The EFFECTIVE consent flag for a (subject, scope): true iff the most recent
   * record is GRANTED. Absence of any record is treated as NOT consented (fails
   * closed) — callers must obtain consent before the gated action.
   */
  async hasConsent(subjectType: string, subjectId: string, scope: string): Promise<boolean> {
    const st = this.assertSubjectType(subjectType);
    const sc = this.assertScope(scope);
    const latest = await this.prisma.consentRecord.findFirst({
      where: { subjectType: st, subjectId, scope: sc },
      orderBy: { recordedAt: 'desc' },
    });
    return latest?.action === 'GRANTED';
  }

  /**
   * Convenience gate for cross-border AI: true iff the subject has GRANTED
   * CROSS_BORDER_AI. Use this to decide whether identifiable subject data may be
   * sent to an overseas AI provider; when false, callers should fall back to a
   * deterministic, non-AI path rather than transmit PII abroad.
   */
  async mayTransferToCrossBorderAi(subjectType: string, subjectId: string): Promise<boolean> {
    return this.hasConsent(subjectType, subjectId, 'CROSS_BORDER_AI');
  }

  private assertSubjectType(value: string): ConsentSubjectType {
    if (!SUBJECT_TYPES.has(value)) {
      throw new ValidationError(
        'subjectType must be one of LEAD, CANDIDATE, INTAKE',
        'CONSENT_SUBJECT_TYPE_INVALID',
      );
    }
    return value as ConsentSubjectType;
  }

  private assertScope(value: string): ConsentScope {
    if (!SCOPES.has(value)) {
      throw new ValidationError(
        'scope must be one of DATA_PROCESSING, MARKETING, CROSS_BORDER_AI',
        'CONSENT_SCOPE_INVALID',
      );
    }
    return value as ConsentScope;
  }

  private toView(row: {
    id: string;
    subjectType: string;
    subjectId: string;
    scope: string;
    action: string;
    source: string;
    note: string | null;
    actor: string;
    recordedAt: Date;
  }): ConsentRecordView {
    return {
      id: row.id,
      subjectType: row.subjectType as ConsentSubjectType,
      subjectId: row.subjectId,
      scope: row.scope as ConsentScope,
      action: row.action as ConsentAction,
      source: row.source,
      note: row.note,
      actor: row.actor,
      recordedAt: row.recordedAt,
    };
  }
}
