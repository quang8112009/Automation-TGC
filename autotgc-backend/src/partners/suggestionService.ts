/**
 * DestinationSuggestionService — đối chiếu hồ sơ ứng viên với database chương
 * trình (DestinationProgram) và gợi ý cho nhân viên tư vấn.
 *
 * I/O shell over the pure `destinationMatcher`: it loads a candidate, projects
 * the profile, loads active/open programs (optionally filtered by country),
 * ranks them, and returns suggestions. SALES is assigned-only on the candidate.
 */
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError } from '../infra/errors';
import { matchDestinations } from '../intake/destinationMatcher';
import type { MatchProfile, ProgramCriteria, DestinationSuggestion } from '../intake/destinationMatcher';

export class DestinationSuggestionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Suggest destination programs for a candidate. Loads the candidate (scoped
   * for SALES), builds the match profile from its columns, loads active programs
   * (OPEN), and ranks them with the pure matcher.
   */
  async suggestForCandidate(
    candidateId: string,
    actor: AuthInfo,
    limit = 10,
  ): Promise<{ candidateId: string; suggestions: DestinationSuggestion[] }> {
    const candidate = await this.prisma.candidateProfile.findUnique({
      where: { id: candidateId },
    });
    if (!candidate) {
      throw new NotFoundError('Candidate not found', 'CANDIDATE_NOT_FOUND');
    }
    if (actor.role === 'SALES' && candidate.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }

    const profile = this.profileFromCandidate(candidate);
    const programs = await this.loadPrograms();
    const suggestions = matchDestinations(profile, programs, limit);
    return { candidateId, suggestions };
  }

  /**
   * Suggest programs from an ad-hoc profile (e.g. directly from a completed
   * intake conversation, before a CandidateProfile exists). ADMIN/consultant use.
   */
  async suggestForProfile(
    profile: MatchProfile,
    limit = 10,
  ): Promise<{ suggestions: DestinationSuggestion[] }> {
    const programs = await this.loadPrograms();
    return { suggestions: matchDestinations(profile, programs, limit) };
  }

  private async loadPrograms(): Promise<ProgramCriteria[]> {
    const rows = await this.prisma.destinationProgram.findMany({
      where: { active: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country,
      visaType: r.visaType,
      minAge: r.minAge,
      maxAge: r.maxAge,
      gender: r.gender,
      requiredLanguage: r.requiredLanguage,
      minLanguageLevel: r.minLanguageLevel,
      budgetMinVndM: r.budgetMinVndM,
      budgetMaxVndM: r.budgetMaxVndM,
      industries: this.toStringArray(r.industries),
      conditions: this.toStringArray(r.conditions),
      status: r.status,
      active: r.active,
    }));
  }

  private profileFromCandidate(c: {
    dob: Date | null;
    gender: string;
    desiredMarket: string | null;
    desiredIndustry: string;
    japaneseLevel: string;
  }): MatchProfile {
    return {
      age: this.ageFromDob(c.dob),
      gender: c.gender,
      country: c.desiredMarket ?? undefined,
      industry: c.desiredIndustry,
      language: c.japaneseLevel && c.japaneseLevel !== 'NONE' ? 'japanese' : '',
      languageLevel: c.japaneseLevel,
    };
  }

  private ageFromDob(dob: Date | null): number | undefined {
    if (!dob || Number.isNaN(dob.getTime())) return undefined;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
    return age > 0 && age < 120 ? age : undefined;
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
  }
}
