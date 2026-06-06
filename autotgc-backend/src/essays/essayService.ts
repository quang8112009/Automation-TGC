/**
 * EssayService — I/O + lifecycle for per-candidate SOP / motivation / CV drafts
 * (study-abroad-ai-advisor-suite — Nhóm 2, Req 6.x, 7.5, 8.2, 8.4, 9.2–9.4, 22.5).
 *
 * The pure decisions live elsewhere: `EssayWriter`/`buildStructuredDraft`
 * (Gemini-optional draft, never throws 502), `reviewEssay` (rubric scoring in
 * [0,1]), and `essayTransition` (guarded REVIEW MODE state machine). This
 * service only persists/queries `EssayDraft` rows, builds the framework-free
 * `EssayContext` from candidate + program data, derives a deterministic default
 * rubric for review, and enforces SALES assigned-only scoping.
 *
 * RBAC: it mirrors `visaService` exactly — `ownerUserId` is resolved from the
 * owning `CandidateProfile.assignedTo`; SALES is assigned-only (403 outside its
 * scope), ADMIN operates on any candidate (Req 9.2, 9.4, 22.5). It deliberately
 * does NOT re-implement the RBAC policy (that lives in `auth/rbac.ts` and is
 * enforced at the route layer); it only resolves the owner and applies the same
 * assigned-only check used across candidate-scoped services.
 */
import type { EssayDraft, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../infra/errors';
import type { ContentGenerator } from '../strategy/personaService';
import { EssayWriter } from './essayWriter';
import type { EssayGenMode } from './essayWriter';
import { reviewEssay } from './essayReviewer';
import { essayTransition } from './essayStateMachine';
import type { EssayStatus } from './essayStateMachine';
import type { EssayContext, EssayDocType, EssayReview, RubricCriterion } from './types';

/** The document kinds accepted by `create` (Req 6.6). */
const ESSAY_DOC_TYPES = ['SOP', 'MOTIVATION', 'CV'] as const;

/** Type guard: is `v` one of the allowed `EssayDocType` values? */
function isEssayDocType(v: unknown): v is EssayDocType {
  return typeof v === 'string' && (ESSAY_DOC_TYPES as readonly string[]).includes(v);
}

/** Input for {@link EssayService.create}. */
export interface CreateEssayInput {
  /** Document kind; validated against {SOP, MOTIVATION, CV} (Req 6.6). */
  docType: string;
  /** Optional target program (grounds the draft when resolvable). */
  programId?: string;
  /** Explicit generation mode (Req 6.7); defaults to 'AI' (falls back when no seam). */
  mode?: EssayGenMode;
}

/** Clamp a number into [0,1]; non-finite → 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? 1 : n;
}

/** Required-section markers used to derive the review rubric, per doc type. */
const REQUIRED_SECTION_KEYWORDS: Readonly<Record<EssayDocType, readonly string[]>> = {
  SOP: ['mục tiêu', 'kết luận', 'chương trình'],
  MOTIVATION: ['động lực', 'mục tiêu', 'kết luận'],
  CV: ['học vấn', 'kinh nghiệm', 'kỹ năng'],
};

/** Relevance keywords (program/field grounding) used to derive the rubric. */
const RELEVANCE_KEYWORDS: readonly string[] = [
  'chương trình',
  'ngành',
  'lĩnh vực',
  'trường',
  'mục tiêu',
  'du học',
];

/** Soft word-count band per doc type for the lengthCompliance dimension. */
const LENGTH_BANDS: Readonly<Record<EssayDocType, { min: number; max: number }>> = {
  SOP: { min: 250, max: 1200 },
  MOTIVATION: { min: 200, max: 1000 },
  CV: { min: 80, max: 700 },
};

/**
 * Derive a DETERMINISTIC default rubric from the essay content. The four
 * dimensions (structure, relevance, lengthCompliance, requiredSections) each get
 * weight 1; per-criterion scores are computed purely from the content so the
 * same content + docType always yields the same rubric (and hence the same
 * review — Req 7.2). Scores are clamped to [0,1].
 */
function deriveDefaultRubric(content: string, docType: EssayDocType): RubricCriterion[] {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;

  // structure: count of non-empty paragraphs (blank-line separated); 4+ → full.
  const paragraphs = trimmed.length === 0 ? 0 : trimmed.split(/\n\s*\n/u).filter((p) => p.trim().length > 0).length;
  const structureScore = clamp01(paragraphs / 4);

  // relevance: fraction of distinct relevance keywords present.
  const relevanceHits = RELEVANCE_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const relevanceScore = clamp01(relevanceHits / RELEVANCE_KEYWORDS.length);

  // lengthCompliance: 1 inside the band; linearly degraded outside it.
  const band = LENGTH_BANDS[docType];
  let lengthScore: number;
  if (words === 0) {
    lengthScore = 0;
  } else if (words < band.min) {
    lengthScore = clamp01(words / band.min);
  } else if (words > band.max) {
    // Degrade towards 0 as length runs away past the upper bound.
    lengthScore = clamp01(band.max / words);
  } else {
    lengthScore = 1;
  }

  // requiredSections: fraction of doc-type-specific required markers present.
  const required = REQUIRED_SECTION_KEYWORDS[docType];
  const requiredHits = required.filter((kw) => lower.includes(kw)).length;
  const requiredScore = required.length === 0 ? 0 : clamp01(requiredHits / required.length);

  return [
    { key: 'structure', weight: 1, score: structureScore },
    { key: 'relevance', weight: 1, score: relevanceScore },
    { key: 'lengthCompliance', weight: 1, score: lengthScore },
    { key: 'requiredSections', weight: 1, score: requiredScore },
  ];
}

export class EssayService {
  private readonly writer: EssayWriter;

  constructor(
    private readonly prisma: PrismaClient,
    /** Optional Gemini seam (GeminiClient satisfies this structurally). */
    gemini?: ContentGenerator,
  ) {
    this.writer = new EssayWriter(gemini);
  }

  /**
   * Resolve a candidate's `assignedTo` for SALES assigned-only scoping. Throws
   * 404 when the candidate is missing; 403 when a SALES actor is not the owner
   * (Req 9.2, 9.3). ADMIN passes through (Req 9.4). Mirrors `visaService`.
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

  /** Load an essay draft + enforce candidate-scoped access (404 if missing). */
  private async requireEssay(essayId: string, actor: AuthInfo): Promise<EssayDraft> {
    const row = await this.prisma.essayDraft.findUnique({ where: { id: essayId } });
    if (!row) {
      throw new NotFoundError('Essay draft not found', 'ESSAY_NOT_FOUND');
    }
    await this.assertCandidateAccess(row.candidateId, actor);
    return row;
  }

  /**
   * Build the framework-free grounding context for the writer from the candidate
   * profile and (when resolvable) the target program. Never carries secrets
   * (Req 6.4).
   */
  private async buildContext(candidateId: string, programId?: string): Promise<EssayContext> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
      select: { fullName: true, education: true, desiredIndustry: true },
    });

    const program = programId
      ? await this.prisma.destinationProgram.findUnique({
          where: { id: programId },
          select: { name: true, country: true, industries: true },
        })
      : null;

    // Prefer the program's first declared industry as the field of study; fall
    // back to the candidate's desired industry. Both are grounded inputs.
    let fieldOfStudy: string | null = candidate?.desiredIndustry?.trim() || null;
    if (program && Array.isArray(program.industries) && program.industries.length > 0) {
      const first = program.industries[0];
      if (typeof first === 'string' && first.trim().length > 0) {
        fieldOfStudy = first.trim();
      }
    }

    return {
      candidateName: candidate?.fullName ?? null,
      educationLevel: candidate?.education ?? null,
      programName: program?.name ?? null,
      programCountry: program?.country ?? null,
      fieldOfStudy,
    };
  }

  /**
   * Create an essay draft for a candidate. Validates `docType ∈ {SOP, MOTIVATION,
   * CV}` (400 otherwise — Req 6.6), builds the grounding context, runs the
   * Gemini-optional writer (never throws 502 — Req 6.2, 6.3), and persists the
   * row in `DRAFT` (Req 6.5) with `aiGenerated` from the writer result (Req 20.1).
   */
  async create(candidateId: string, input: CreateEssayInput, actor: AuthInfo): Promise<EssayDraft> {
    if (!isEssayDocType(input.docType)) {
      throw new ValidationError('Invalid essay docType', 'ESSAY_DOCTYPE_INVALID');
    }
    const docType = input.docType;
    await this.assertCandidateAccess(candidateId, actor);

    const ctx = await this.buildContext(candidateId, input.programId);
    const mode: EssayGenMode = input.mode === 'STRUCTURED' ? 'STRUCTURED' : 'AI';
    const result = await this.writer.write(ctx, docType, mode);

    return this.prisma.essayDraft.create({
      data: {
        candidateId,
        docType,
        programId: input.programId ?? null,
        content: result.content,
        aiGenerated: result.aiGenerated,
        status: 'DRAFT',
      },
    });
  }

  /** List a candidate's essay drafts (scoped), newest first. */
  async list(candidateId: string, actor: AuthInfo): Promise<EssayDraft[]> {
    await this.assertCandidateAccess(candidateId, actor);
    return this.prisma.essayDraft.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Review an essay draft against a deterministic default rubric derived from its
   * content (Req 7.1–7.4). Rejects with 400 when the content is blank after
   * trimming (Req 7.5). Returns the `EssayReview` (score ∈ [0,1] + feedback).
   */
  async review(essayId: string, actor: AuthInfo): Promise<EssayReview> {
    const row = await this.requireEssay(essayId, actor);
    if (row.content.trim().length === 0) {
      throw new ValidationError('Essay content is empty', 'ESSAY_CONTENT_EMPTY');
    }
    const docType = row.docType as EssayDocType;
    const rubric = deriveDefaultRubric(row.content, docType);
    return reviewEssay(row.content, docType, rubric);
  }

  /**
   * Transition an essay draft's status through the guarded state machine. Illegal
   * transitions → 409 with the status unchanged (Req 8.2). A transition into
   * `APPROVED` records the approver and approval timestamp (Req 8.4).
   */
  async transition(essayId: string, target: EssayStatus, actor: AuthInfo): Promise<EssayDraft> {
    const row = await this.requireEssay(essayId, actor);
    const result = essayTransition(row.status as EssayStatus, target);
    if (!result.ok) {
      throw new ConflictError('Illegal essay status transition', 'ESSAY_TRANSITION_ILLEGAL');
    }

    const data: {
      status: EssayStatus;
      approvedBy?: string;
      approvedAt?: Date;
    } = { status: result.status };
    if (result.status === 'APPROVED') {
      data.approvedBy = actor.userId;
      data.approvedAt = new Date();
    }

    return this.prisma.essayDraft.update({ where: { id: essayId }, data });
  }

  /**
   * Delete an essay draft (scoped). SALES retains full CRUD on its assigned
   * candidates' drafts (the route maps this to the `update` action, not
   * `delete`, per Req 22.5); ADMIN may delete any draft. Loads + enforces
   * candidate-scoped access (404 if missing, 403 outside a SALES actor's scope)
   * exactly like the other mutators before removing the row.
   */
  async remove(essayId: string, actor: AuthInfo): Promise<void> {
    const row = await this.requireEssay(essayId, actor);
    await this.prisma.essayDraft.delete({ where: { id: row.id } });
  }
}
