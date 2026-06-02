/**
 * DocExtractionService — I/O + scoping + persistence for AI Document OCR &
 * Verification (Feature 1). A candidate sends a photo of an IELTS/TOEFL/
 * transcript/financial document; an OCR provider extracts text; the PURE engine
 * (`docExtraction.ts`) parses fields + verifies them against a target
 * requirement; if unreadable it asks for a resend (NEEDS_RESEND).
 *
 * Layering (per the steering rules): ALL parsing/verification logic lives in the
 * pure, framework-free engine — this service only does I/O (OCR provider seam),
 * SALES assigned-only scoping (mirrors CandidateService), and persistence of a
 * `DocumentExtraction` row. It never re-implements parse/verify logic.
 *
 * The OCR provider is the optional `OcrProvider` seam (mirrors the
 * RenderProvider seam in marketing/assets/assetGenerator.ts). When absent, a
 * `NoopOcrProvider` is used and unreadable input degrades to NEEDS_RESEND — we
 * never fabricate OCR text.
 */
import type { DocumentExtraction, Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError } from '../infra/errors';
import {
  parseDocumentText,
  verifyExtraction,
} from './docExtraction';
import type { DocRequirement, DocType } from './docExtraction';
import { NoopOcrProvider } from './ocrProvider';
import type { OcrProvider } from './ocrProvider';

/** Input to submit one document for extraction + verification. */
export interface SubmitDocInput {
  candidateId: string;
  /** Soft reference to a DocumentChecklistItem.id (no FK). */
  checklistItemId?: string;
  docType: DocType;
  /** Pre-extracted text (skips OCR when provided). */
  rawText?: string;
  /** Inline image bytes (base64) for the OCR provider. */
  imageBase64?: string;
  /** MIME type of the image. */
  mimeType?: string;
  /** Where the source image is stored. */
  storageKey?: string;
  /** Target requirement to verify against (min score/GPA/amount, in-date). */
  requirement?: DocRequirement;
}

/** Serialize an arbitrary JSON-able value for a Prisma Json column. */
function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class DocExtractionService {
  private readonly ocr: OcrProvider;

  constructor(
    private readonly prisma: PrismaClient,
    ocr?: OcrProvider,
  ) {
    // No vision model wired by default → NoopOcrProvider → NEEDS_RESEND.
    this.ocr = ocr ?? new NoopOcrProvider();
  }

  /**
   * Submit a document: enforce SALES assigned-only on the candidate, obtain the
   * document text (provided rawText, else the OCR provider), run the PURE engine
   * (parse + verify), and persist a DocumentExtraction row. Returns the row.
   */
  async submit(input: SubmitDocInput, actor: AuthInfo): Promise<DocumentExtraction> {
    // Scope: load the candidate's assignedTo; 404 if missing, 403 if SALES and
    // not the assigned owner (mirrors CandidateService).
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: input.candidateId },
      select: { id: true, assignedTo: true },
    });
    if (!candidate) {
      throw new NotFoundError('Candidate not found');
    }
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }

    // Obtain text: prefer the provided rawText; otherwise call the OCR provider
    // (NoopOcrProvider by default → empty text, zero confidence).
    let rawText: string;
    let confidence: number;
    let provider: string;
    if (typeof input.rawText === 'string') {
      rawText = input.rawText;
      // Caller-provided text is trusted as a clean transcription.
      confidence = 1;
      provider = 'provided';
    } else {
      const out = await this.ocr.extractText({
        storageKey: input.storageKey,
        imageBase64: input.imageBase64,
        mimeType: input.mimeType,
      });
      rawText = out.text;
      confidence = out.confidence;
      provider = this.ocr.name ?? 'none';
    }

    // PURE engine: parse fields, then verify against the requirement.
    const requirement: DocRequirement = input.requirement ?? {};
    const fields = parseDocumentText(input.docType, rawText);
    const result = verifyExtraction(input.docType, fields, requirement, confidence);

    // Snapshot the requirement + outcome for auditability.
    const verifiedAgainst = toInputJson({
      requirement: serializeRequirement(requirement),
      met: result.met,
    });

    const data: Prisma.DocumentExtractionUncheckedCreateInput = {
      candidateId: input.candidateId,
      checklistItemId: input.checklistItemId ?? null,
      docType: input.docType,
      // Engine statuses (VERIFIED|FAILED|NEEDS_RESEND|EXTRACTED) are a subset of
      // the DocExtractionStatus enum, so they map through directly.
      status: result.status,
      storageKey: input.storageKey ?? '',
      extractedFields: toInputJson(fields),
      confidence,
      issues: toInputJson(result.issues),
      rawText,
      provider,
      verifiedAgainst,
    };

    return this.prisma.documentExtraction.create({ data });
  }

  /** List a candidate's extractions (newest first), SALES assigned-only scoped. */
  async list(candidateId: string, actor: AuthInfo): Promise<DocumentExtraction[]> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
      select: { id: true, assignedTo: true },
    });
    if (!candidate) {
      throw new NotFoundError('Candidate not found');
    }
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }

    return this.prisma.documentExtraction.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Fetch one extraction by id. The owning candidate is resolved from the row so
   * the same SALES assigned-only policy applies; 404 if the row is missing.
   */
  async get(id: string, actor: AuthInfo): Promise<DocumentExtraction> {
    const row = await this.prisma.documentExtraction.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundError('Document extraction not found');
    }
    if (actor.role === 'SALES') {
      const candidate = await this.prisma.candidateProfile.findUnique({
        where: { id: row.candidateId },
        select: { assignedTo: true },
      });
      if (!candidate || candidate.assignedTo !== actor.userId) {
        throw new ForbiddenError();
      }
    }
    return row;
  }
}

/** JSON-safe view of a requirement (Date → ISO string) for the snapshot. */
function serializeRequirement(req: DocRequirement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (req.minScore !== undefined) out.minScore = req.minScore;
  if (req.minGpa !== undefined) out.minGpa = req.minGpa;
  if (req.minAmountVndM !== undefined) out.minAmountVndM = req.minAmountVndM;
  if (req.asOf !== undefined) out.asOf = req.asOf.toISOString();
  return out;
}
