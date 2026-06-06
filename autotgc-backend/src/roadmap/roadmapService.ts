/**
 * RoadmapService — I/O + lifecycle for per-candidate study→career→PR roadmap
 * estimates, profile-readiness scoring, and REVIEW MODE roadmap narratives
 * (study-abroad-ai-advisor-suite — Nhóm 5, Req 16.1, 16.5, 17.1–17.5, 18.1, 18.5).
 *
 * The pure decisions live elsewhere and are REUSED here, never duplicated:
 *  - `estimateRoadmap` (ROI estimate; net cost via `scholarshipMatcher` — Req 16.1)
 *  - `scoreReadiness` (readiness score ∈ [0,1] + grounded gaps — Req 18.1, 18.5)
 *  - `RoadmapNarrative.narrate` (Gemini-optional narration, never 502 — Req 17.1, 17.2)
 *  - `essayTransition` (the SAME guarded REVIEW MODE state machine as essays —
 *    Req 17.3; the lifecycle is NOT re-implemented here).
 *
 * RBAC: mirrors `visaService` / `essayService` exactly — `ownerUserId` is
 * resolved from the owning `CandidateProfile.assignedTo`; SALES is assigned-only
 * (403 outside its scope), ADMIN operates on any candidate; a missing candidate
 * → 404. The fine-grained policy itself lives in `auth/rbac.ts` and is enforced
 * at the route layer; this service only resolves the owner and applies the same
 * assigned-only check used across candidate-scoped services.
 */
import type { PrismaClient, Prisma, RoadmapNarrative as RoadmapNarrativeRow } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ConflictError, ForbiddenError, NotFoundError } from '../infra/errors';
import type { ContentGenerator } from '../strategy/personaService';
import type { KnowledgeService } from '../recruitment/knowledge/knowledgeService';
import { estimateRoadmap } from './roadmapEstimator';
import type { KnowledgeNote, RoadmapEstimate } from './types';
import { scoreReadiness } from './readinessScorer';
import type { ReadinessResult } from './readinessScorer';
import { RoadmapNarrative } from './roadmapNarrative';
import { essayTransition } from '../essays/essayStateMachine';
import type { EssayStatus } from '../essays/essayStateMachine';
import type { EssayGenMode } from '../essays/essayWriter';
import type { StudentFinance, ProgramFinance } from '../partners/scholarshipMatcher';
import type { AcademicSignals, ProgramThresholds, SelectivityTier } from '../admissions/types';
import type { ChecklistItemLike, DocSubmissionStatus } from '../recruitment/documents/completion';

/** Number of knowledge entries retrieved to ground career / PR roadmap notes. */
const ROADMAP_RETRIEVAL_LIMIT = 5;

/** Allowed program selectivity tiers; anything else is treated as unset (→ MEDIUM). */
const SELECTIVITY_TIERS: readonly SelectivityTier[] = ['HIGH', 'MEDIUM', 'LOW'];

/** Narrow a free-form selectivity column into a `SelectivityTier` or null. */
function narrowSelectivity(value: string | null | undefined): SelectivityTier | null {
  return typeof value === 'string' && (SELECTIVITY_TIERS as readonly string[]).includes(value)
    ? (value as SelectivityTier)
    : null;
}

export class RoadmapService {
  private readonly narrator: RoadmapNarrative;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly knowledge: KnowledgeService,
    /** Optional Gemini seam (GeminiClient satisfies this structurally). */
    private readonly gemini?: ContentGenerator,
  ) {
    this.narrator = new RoadmapNarrative(gemini);
  }

  /**
   * Resolve a candidate's `assignedTo` for SALES assigned-only scoping. Mirrors
   * `VisaService.assertCandidateAccess`: missing candidate → 404; a SALES actor
   * working a candidate they are not assigned to → 403; ADMIN passes through.
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
   * Load a destination program and project it into the framework-free
   * `ProgramFinance` shape reused by `estimateRoadmap` / `scholarshipMatcher`.
   * Throws 404 when the program is missing.
   */
  private async requireProgramFinance(programId: string): Promise<{
    program: ProgramFinance;
    country: string;
    visaType: string;
  }> {
    const row = await this.prisma.destinationProgram.findUnique({
      where: { id: programId },
      select: {
        id: true,
        name: true,
        country: true,
        visaType: true,
        tuitionPerYearVndM: true,
        livingCostPerYearVndM: true,
        scholarshipMaxPct: true,
        minGpa: true,
        minIelts: true,
      },
    });
    if (!row) {
      throw new NotFoundError('Destination program not found', 'PROGRAM_NOT_FOUND');
    }
    return {
      program: {
        id: row.id,
        name: row.name,
        country: row.country,
        tuitionPerYearVndM: row.tuitionPerYearVndM,
        livingCostPerYearVndM: row.livingCostPerYearVndM,
        scholarshipMaxPct: row.scholarshipMaxPct,
        minGpa: row.minGpa,
        minIelts: row.minIelts,
      },
      country: row.country,
      visaType: row.visaType ?? '',
    };
  }

  /** Project a candidate's `AcademicProfile` into framework-free `AcademicSignals`. */
  private async loadAcademic(candidateId: string): Promise<AcademicSignals> {
    const academic = await this.prisma.academicProfile.findUnique({
      where: { candidateId },
      select: {
        gpa: true,
        gpaScale: true,
        ielts: true,
        toefl: true,
        jlpt: true,
        educationLevel: true,
      },
    });
    return {
      gpa: academic?.gpa ?? null,
      gpaScale: academic?.gpaScale ?? null,
      ielts: academic?.ielts ?? null,
      toefl: academic?.toefl ?? null,
      jlpt: academic?.jlpt ?? null,
      educationLevel: academic?.educationLevel ?? null,
    };
  }

  /**
   * Build the `StudentFinance` input for the reused financial core from the
   * candidate's academic signals. GPA is linearly converted to the 10-scale the
   * matcher expects ONLY when `gpaScale` is finite and > 0 (mirrors the
   * `normalizeGpa` precondition — no division by a non-positive scale, no
   * fabricated conversion). Budget is not stored on the candidate so it is left
   * undefined; net study cost (the figure `estimateRoadmap` surfaces) does not
   * depend on budget.
   */
  private toStudentFinance(academic: AcademicSignals): StudentFinance {
    const student: StudentFinance = {};
    if (
      typeof academic.gpa === 'number' &&
      Number.isFinite(academic.gpa) &&
      typeof academic.gpaScale === 'number' &&
      Number.isFinite(academic.gpaScale) &&
      academic.gpaScale > 0
    ) {
      student.gpa = (academic.gpa / academic.gpaScale) * 10;
    }
    if (typeof academic.ielts === 'number' && Number.isFinite(academic.ielts)) {
      student.ielts = academic.ielts;
    }
    return student;
  }

  /**
   * Retrieve active knowledge-base notes that ground the career / PR guidance,
   * projected into the framework-free `KnowledgeNote` shape. Grounding only —
   * `estimateRoadmap` decides which notes are relevant by keyword. Never throws
   * for missing grounding (an empty list is valid).
   */
  private async groundingNotes(country: string, visaType: string): Promise<KnowledgeNote[]> {
    const query = [country, visaType, 'việc làm định cư thường trú nghề nghiệp career PR']
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join(' ');
    const rows = await this.knowledge.search(query, ROADMAP_RETRIEVAL_LIMIT);
    return rows.map((r) => ({ title: r.title, content: r.content }));
  }

  /**
   * Estimate the study → career → PR roadmap ROI for a (candidate, program)
   * pair. Scopes the candidate (404/403), loads the candidate's academic signals
   * and the program's finances, retrieves grounding notes, and delegates to the
   * pure `estimateRoadmap`. Missing financial data surfaces as
   * `'INSUFFICIENT_DATA'` per-metric rather than a misleading number (Req 16.5).
   * The net cost is taken DIRECTLY from `scholarshipMatcher` (Req 16.1).
   */
  async estimate(candidateId: string, programId: string, actor: AuthInfo): Promise<RoadmapEstimate> {
    await this.assertCandidateAccess(candidateId, actor);
    const { program, country, visaType } = await this.requireProgramFinance(programId);
    const academic = await this.loadAcademic(candidateId);
    const student = this.toStudentFinance(academic);
    const knowledge = await this.groundingNotes(country, visaType);
    return estimateRoadmap(student, program, knowledge);
  }

  /**
   * Score a candidate's profile readiness (∈ [0,1] or `'INSUFFICIENT_DATA'`) plus
   * a grounded gap list (Req 18.1, 18.5). Scopes the candidate, projects their
   * `DocumentChecklistItem`s and `AcademicProfile`, and — when an optional target
   * `programId` is supplied — the program's published thresholds, then delegates
   * to the pure `scoreReadiness`.
   */
  async readiness(candidateId: string, actor: AuthInfo, programId?: string): Promise<ReadinessResult> {
    await this.assertCandidateAccess(candidateId, actor);

    const [docRows, academic] = await Promise.all([
      this.prisma.documentChecklistItem.findMany({
        where: { candidateId },
        select: { required: true, status: true },
      }),
      this.loadAcademic(candidateId),
    ]);

    const documents: ChecklistItemLike[] = docRows.map((r) => ({
      required: r.required,
      status: r.status as DocSubmissionStatus,
    }));

    const thresholds = programId ? await this.loadThresholds(programId) : undefined;

    return scoreReadiness({ documents, academic, thresholds });
  }

  /**
   * Create a roadmap narrative for a (candidate, program) pair and persist it in
   * `DRAFT` (REVIEW MODE — Req 17.3). Computes the estimate, retrieves grounding
   * notes, and narrates via the Gemini-optional `RoadmapNarrative` (never throws
   * 502 — Req 17.1, 17.2). The explicit `mode` (Req 6.7-style) forces the
   * deterministic narrative for `'STRUCTURED'` regardless of the Gemini seam.
   * The serialized `RoadmapEstimate` and `aiGenerated` flag are stored on the row.
   */
  async createNarrative(
    candidateId: string,
    programId: string,
    mode: EssayGenMode,
    actor: AuthInfo,
  ): Promise<RoadmapNarrativeRow> {
    await this.assertCandidateAccess(candidateId, actor);
    const { program, country, visaType } = await this.requireProgramFinance(programId);
    const academic = await this.loadAcademic(candidateId);
    const student = this.toStudentFinance(academic);
    const knowledge = await this.groundingNotes(country, visaType);
    const estimate = estimateRoadmap(student, program, knowledge);

    // 'STRUCTURED' → always deterministic (a narrator without the Gemini seam);
    // 'AI' → use the configured seam when present (Gemini-optional fallback).
    const narrator = mode === 'STRUCTURED' ? new RoadmapNarrative() : this.narrator;
    const { text, aiGenerated } = await narrator.narrate(estimate, knowledge);

    return this.prisma.roadmapNarrative.create({
      data: {
        candidateId,
        programId,
        estimate: estimate as unknown as Prisma.InputJsonValue,
        narrative: text,
        aiGenerated,
        status: 'DRAFT',
      },
    });
  }

  /**
   * Transition a roadmap narrative's status through the SAME guarded state
   * machine as essays (`essayTransition` — Req 17.3, no duplication). Illegal
   * transitions → 409 with the status unchanged. A transition into `APPROVED`
   * records the approver and approval timestamp. Scoped via the owning
   * candidate.
   */
  async transitionNarrative(
    id: string,
    target: EssayStatus,
    actor: AuthInfo,
  ): Promise<RoadmapNarrativeRow> {
    const row = await this.prisma.roadmapNarrative.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundError('Roadmap narrative not found', 'ROADMAP_NARRATIVE_NOT_FOUND');
    }
    await this.assertCandidateAccess(row.candidateId, actor);

    const result = essayTransition(row.status as EssayStatus, target);
    if (!result.ok) {
      throw new ConflictError('Illegal roadmap narrative status transition', 'ROADMAP_TRANSITION_ILLEGAL');
    }

    const data: { status: EssayStatus; approvedBy?: string; approvedAt?: Date } = {
      status: result.status,
    };
    if (result.status === 'APPROVED') {
      data.approvedBy = actor.userId;
      data.approvedAt = new Date();
    }

    return this.prisma.roadmapNarrative.update({ where: { id }, data });
  }

  /**
   * Load a destination program's published admission thresholds, projected into
   * the framework-free `ProgramThresholds` shape reused by `scoreReadiness` /
   * `suggestGaps`. Returns `undefined` when the program is missing so readiness
   * falls back to the no-target case rather than throwing.
   */
  private async loadThresholds(programId: string): Promise<ProgramThresholds | undefined> {
    const row = await this.prisma.destinationProgram.findUnique({
      where: { id: programId },
      select: {
        id: true,
        name: true,
        country: true,
        minGpa: true,
        minIelts: true,
        minToefl: true,
        minJlpt: true,
        selectivityTier: true,
      },
    });
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      country: row.country,
      minGpa: row.minGpa,
      minIelts: row.minIelts,
      minToefl: row.minToefl,
      minJlpt: row.minJlpt,
      selectivityTier: narrowSelectivity(row.selectivityTier),
    };
  }
}
