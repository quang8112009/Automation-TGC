/**
 * ScholarshipService — đối chiếu ngân sách/năm + GPA + IELTS của ứng viên với
 * database chương trình (DestinationProgram, có dữ liệu tài chính) để tính các
 * chương trình trong khả năng chi trả và ước tính học bổng, rồi gợi ý cho nhân
 * viên tư vấn.
 *
 * I/O shell over the pure `scholarshipMatcher`: it loads a candidate (scoped for
 * SALES), builds the StudentFinance input, loads active programs, maps rows →
 * ProgramFinance, and ranks them with the pure matcher. ALL financial math stays
 * in the pure engine. Mirrors the structure of `DestinationSuggestionService`.
 */
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError } from '../infra/errors';
import { matchScholarships } from './scholarshipMatcher';
import type { StudentFinance, ProgramFinance, ScholarshipResult } from './scholarshipMatcher';

/** Optional finance override supplied per-request (query/body). */
export interface FinanceOverride {
  budgetPerYearVndM?: number;
  gpa?: number;
  ielts?: number;
}

export class ScholarshipService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Suggest affordable programs + estimated scholarships for a candidate. Loads
   * the candidate (scoped for SALES), builds StudentFinance from the supplied
   * `finance` override merged over any derivable defaults, loads active programs,
   * and ranks them with the pure matcher.
   *
   * gpa/ielts/budget are NOT columns on CandidateProfile, so they are accepted
   * via the optional `finance` override; when nothing is supplied we simply pass
   * through what's given (an empty StudentFinance), which the matcher handles.
   */
  async suggestForCandidate(
    candidateId: string,
    actor: AuthInfo,
    limit = 10,
    finance?: FinanceOverride,
  ): Promise<{ candidateId: string; results: ScholarshipResult[] }> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
    });
    if (!candidate) {
      throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');
    }
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }

    const student = this.financeFromCandidate(finance);
    const programs = await this.loadPrograms();
    const results = matchScholarships(student, programs, limit);
    return { candidateId, results };
  }

  /**
   * Suggest programs from an ad-hoc finance profile (no candidate) — e.g. a quick
   * what-if from the consultant. ADMIN/consultant use.
   */
  async suggestForProfile(
    finance: FinanceOverride,
    limit = 10,
  ): Promise<{ results: ScholarshipResult[] }> {
    const programs = await this.loadPrograms();
    return { results: matchScholarships(this.toStudentFinance(finance), programs, limit) };
  }

  private async loadPrograms(): Promise<ProgramFinance[]> {
    const rows = await this.prisma.destinationProgram.findMany({
      where: { active: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country,
      tuitionPerYearVndM: r.tuitionPerYearVndM,
      livingCostPerYearVndM: r.livingCostPerYearVndM,
      scholarshipMaxPct: r.scholarshipMaxPct,
      minGpa: r.minGpa,
      minIelts: r.minIelts,
    }));
  }

  /**
   * Build the StudentFinance for a candidate. gpa/ielts/budget are not stored on
   * CandidateProfile, so the override is the only source of those values today;
   * this keeps a single place to merge in any derivable defaults later.
   */
  private financeFromCandidate(finance?: FinanceOverride): StudentFinance {
    return this.toStudentFinance(finance ?? {});
  }

  /** Pass through only the finite numeric fields the matcher understands. */
  private toStudentFinance(finance: FinanceOverride): StudentFinance {
    const student: StudentFinance = {};
    if (Number.isFinite(finance.budgetPerYearVndM)) student.budgetPerYearVndM = finance.budgetPerYearVndM;
    if (Number.isFinite(finance.gpa)) student.gpa = finance.gpa;
    if (Number.isFinite(finance.ielts)) student.ielts = finance.ielts;
    return student;
  }
}
