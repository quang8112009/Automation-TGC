/**
 * AdmissionService — I/O + RBAC for the Admissions capability
 * (study-abroad-ai-advisor-suite — Nhóm 1, Req 1.3–1.6, 5.1, 5.3–5.6).
 *
 * The hard decisions live in pure, framework-free modules that this service
 * only orchestrates and persists around:
 *  - `scoreAdmission` / `normalizeGpa` (`./admissionScorer`) — admission
 *    likelihood ∈ [0,1] or `'INSUFFICIENT_DATA'`, GPA normalization guarded by
 *    `gpaScale > 0`.
 *  - `classifyBand` (`./admissionBand`) — selectivity-aware Reach/Match/Safety.
 *  - `suggestGaps` (`./gapSuggestion`) — program-published gap targets.
 *  - `scoreFinance` (`../partners/scholarshipMatcher`) — reused for the
 *    financial-fit dimension; cost is NOT recomputed here.
 *
 * RBAC mirrors `visaService` exactly: `ownerUserId` is resolved from the owning
 * `CandidateProfile.assignedTo`; SALES is assigned-only (403 outside its scope —
 * Req 1.6, 5.3, 5.4), ADMIN operates on any candidate (Req 5.6), and a missing
 * candidate yields 404 (Req 5.5). The policy itself lives in `auth/rbac.ts` and
 * is enforced at the route layer (task 8.1); this service applies the same
 * assigned-only owner check used across candidate-scoped services.
 */
import type { AcademicProfile, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError, ValidationError } from '../infra/errors';
import { normalizeGpa, scoreAdmission } from './admissionScorer';
import { classifyBand } from './admissionBand';
import { suggestGaps } from './gapSuggestion';
import type { AcademicSignals, AdmissionResult, ProgramThresholds, SelectivityTier } from './types';
import type { ProgramFinance, StudentFinance } from '../partners/scholarshipMatcher';
import { scoreFinance } from '../partners/scholarshipMatcher';

/**
 * Input for {@link AdmissionService.upsertAcademic}. All fields are optional and
 * nullable — a missing signal means "that dimension is unknown" and is stored as
 * `null` rather than a fabricated value (Req 1.1).
 */
export interface AcademicInput {
  gpa?: number | null;
  /** GPA scale (e.g. 10 or 4.0); required & must be > 0 when `gpa` is provided (Req 1.3). */
  gpaScale?: number | null;
  ielts?: number | null;
  toefl?: number | null;
  jlpt?: string | null;
  educationLevel?: string | null;
}

/** Coerce a free-form DB string into a known {@link SelectivityTier}, or null. */
function toSelectivityTier(value: string | null | undefined): SelectivityTier | null {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' ? value : null;
}

/**
 * Deterministic sort order for bands: more-favourable first (SAFETY ≻ MATCH ≻
 * REACH), with `'INSUFFICIENT_DATA'` entries sorted last (Req 3.3).
 */
function bandOrder(band: AdmissionResult['band']): number {
  switch (band) {
    case 'SAFETY':
      return 0;
    case 'MATCH':
      return 1;
    case 'REACH':
      return 2;
    default:
      return 3; // INSUFFICIENT_DATA → last
  }
}

/** Numeric score for sorting; the missing-data label sorts as the lowest score. */
function scoreValue(score: AdmissionResult['score']): number {
  return typeof score === 'number' ? score : Number.NEGATIVE_INFINITY;
}

export class AdmissionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Resolve a candidate's `assignedTo` for SALES assigned-only scoping. Throws
   * 404 when the candidate is missing (Req 5.5); 403 when a SALES actor is not
   * the owner (Req 1.6, 5.3, 5.4). ADMIN passes through (Req 5.6). Mirrors
   * `visaService.assertCandidateAccess`.
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
   * Validate the academic input boundaries before persisting:
   *  - When `gpa` is provided it must be a finite number, `gpaScale` must be
   *    provided and strictly positive (Req 1.3), and `gpa` must lie within
   *    `[0, gpaScale]` (Req 1.4) — otherwise 400.
   *  - When `ielts` is provided it must be within `[0, 9]` (Req 1.5) — otherwise 400.
   */
  private validateAcademicInput(input: AcademicInput): void {
    const gpaProvided = input.gpa !== undefined && input.gpa !== null;
    if (gpaProvided) {
      if (typeof input.gpa !== 'number' || !Number.isFinite(input.gpa)) {
        throw new ValidationError('gpa must be a finite number', 'ACADEMIC_GPA_INVALID');
      }
      const scale = input.gpaScale;
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
        throw new ValidationError(
          'gpaScale (> 0) is required when gpa is provided',
          'ACADEMIC_GPA_SCALE_REQUIRED',
        );
      }
      if (input.gpa < 0 || input.gpa > scale) {
        throw new ValidationError('gpa must be within [0, gpaScale]', 'ACADEMIC_GPA_OUT_OF_RANGE');
      }
    }

    const ieltsProvided = input.ielts !== undefined && input.ielts !== null;
    if (ieltsProvided) {
      if (
        typeof input.ielts !== 'number' ||
        !Number.isFinite(input.ielts) ||
        input.ielts < 0 ||
        input.ielts > 9
      ) {
        throw new ValidationError('ielts must be within [0, 9]', 'ACADEMIC_IELTS_OUT_OF_RANGE');
      }
    }
  }

  /**
   * Create or update the candidate's 1–1 `AcademicProfile` (Req 1.1). Scopes
   * access (Req 1.6) then validates the GPA/IELTS boundaries (Req 1.4, 1.5)
   * before the upsert. Returns the persisted row.
   */
  async upsertAcademic(
    candidateId: string,
    input: AcademicInput,
    actor: AuthInfo,
  ): Promise<AcademicProfile> {
    await this.assertCandidateAccess(candidateId, actor);
    this.validateAcademicInput(input);

    const data = {
      gpa: input.gpa ?? null,
      gpaScale: input.gpaScale ?? null,
      ielts: input.ielts ?? null,
      toefl: input.toefl ?? null,
      jlpt: input.jlpt ?? null,
      educationLevel: input.educationLevel ?? null,
    };

    return this.prisma.academicProfile.upsert({
      where: { candidateId },
      create: { candidateId, ...data },
      update: data,
    });
  }

  /**
   * Read the candidate's `AcademicProfile` (scoped — Req 1.6), or `null` when it
   * has not been recorded yet.
   */
  async getAcademic(candidateId: string, actor: AuthInfo): Promise<AcademicProfile | null> {
    await this.assertCandidateAccess(candidateId, actor);
    return this.prisma.academicProfile.findUnique({ where: { candidateId } });
  }

  /**
   * Score a candidate across the whole active program catalogue and return an
   * `AdmissionResult[]` (Req 5.1). Loads the candidate's `AcademicProfile` →
   * `AcademicSignals`, then for each active `DestinationProgram` projects its
   * thresholds + finance, runs the pure scorer/banding/gap modules, and assembles
   * a result. Reuses `scoreFinance` for the financial-fit input — cost is not
   * recomputed.
   *
   * Access is scoped first (404 missing — Req 5.5; SALES non-owner 403 —
   * Req 5.3/5.4; ADMIN any — Req 5.6).
   *
   * Results are sorted deterministically: more-favourable band first
   * (SAFETY, MATCH, REACH), then score descending, then name ascending, then id
   * ascending; `'INSUFFICIENT_DATA'`-banded entries sort last (Req 3.3).
   */
  async scoreCandidate(candidateId: string, actor: AuthInfo): Promise<AdmissionResult[]> {
    await this.assertCandidateAccess(candidateId, actor);

    const academic = await this.prisma.academicProfile.findUnique({ where: { candidateId } });
    const signals: AcademicSignals = academic
      ? {
          gpa: academic.gpa,
          gpaScale: academic.gpaScale,
          ielts: academic.ielts,
          toefl: academic.toefl,
          jlpt: academic.jlpt,
          educationLevel: academic.educationLevel,
        }
      : {};

    // Assemble the reused StudentFinance once. `budgetPerYearVndM` is left
    // undefined because the current `CandidateProfile` model carries no budget
    // signal to derive it from (no fabricated affordability). `gpa` is derived
    // on the 10-scale that `scoreFinance` expects via the guarded `normalizeGpa`
    // (returns undefined for an invalid scale), and `ielts` is taken as-is.
    const normalizedGpa = normalizeGpa(signals.gpa, signals.gpaScale);
    const student: StudentFinance = {
      budgetPerYearVndM: undefined,
      gpa: normalizedGpa === undefined ? undefined : normalizedGpa * 10,
      ielts: signals.ielts ?? undefined,
    };

    const programs = await this.prisma.destinationProgram.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        country: true,
        minGpa: true,
        minIelts: true,
        minToefl: true,
        minJlpt: true,
        selectivityTier: true,
        tuitionPerYearVndM: true,
        livingCostPerYearVndM: true,
        scholarshipMaxPct: true,
      },
    });

    const results: AdmissionResult[] = programs.map((p) => {
      const thresholds: ProgramThresholds = {
        id: p.id,
        name: p.name,
        country: p.country,
        minGpa: p.minGpa,
        minIelts: p.minIelts,
        minToefl: p.minToefl,
        minJlpt: p.minJlpt,
        selectivityTier: toSelectivityTier(p.selectivityTier),
      };
      const program: ProgramFinance = {
        id: p.id,
        name: p.name,
        country: p.country,
        tuitionPerYearVndM: p.tuitionPerYearVndM,
        livingCostPerYearVndM: p.livingCostPerYearVndM,
        scholarshipMaxPct: p.scholarshipMaxPct,
        minGpa: p.minGpa,
        minIelts: p.minIelts,
      };

      const score = scoreAdmission(signals, thresholds, { student, program });
      const band = classifyBand(score, thresholds.selectivityTier);
      const gaps = suggestGaps(signals, thresholds);

      return { programId: p.id, name: p.name, country: p.country, score, band, gaps };
    });

    results.sort((a, b) => {
      const byBand = bandOrder(a.band) - bandOrder(b.band);
      if (byBand !== 0) return byBand;

      const av = scoreValue(a.score);
      const bv = scoreValue(b.score);
      if (av !== bv) return bv - av; // score descending

      if (a.name !== b.name) return a.name < b.name ? -1 : 1; // name ascending
      if (a.programId !== b.programId) return a.programId < b.programId ? -1 : 1; // id ascending
      return 0;
    });

    return results;
  }
}
