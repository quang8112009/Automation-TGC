/**
 * Destination_Matcher — pure eligibility scoring of a candidate profile against
 * DestinationProgram conditions (đối chiếu với database & gợi ý cho tư vấn).
 *
 * Framework-free and deterministic so it is property-testable: given a
 * normalized profile and a list of programs, it returns ranked suggestions with
 * a 0..100 fit score, the matched conditions, and any BLOCKING mismatches (hard
 * fails like age/gender/budget out of range). The service layer loads programs
 * from Prisma and maps intake answers onto this profile shape.
 */

export interface MatchProfile {
  age?: number;
  gender?: string; // 'MALE' | 'FEMALE' | 'Nam' | 'Nữ' | ''
  country?: string; // desired market/country (free-form)
  industry?: string; // desired industry (free-form)
  language?: string; // e.g. 'japanese' | 'english' | ''
  languageLevel?: string; // e.g. 'N4' | 'IELTS5.5'
  budgetVndM?: number; // candidate budget ceiling (million VND)
}

export interface ProgramCriteria {
  id: string;
  name: string;
  country: string;
  visaType?: string;
  minAge?: number | null;
  maxAge?: number | null;
  gender?: string; // 'ANY' | 'MALE' | 'FEMALE'
  requiredLanguage?: string;
  minLanguageLevel?: string;
  budgetMinVndM?: number | null;
  budgetMaxVndM?: number | null;
  industries?: readonly string[];
  conditions?: readonly string[];
  status?: string; // 'OPEN' | ...
  active?: boolean;
}

export interface DestinationSuggestion {
  programId: string;
  name: string;
  country: string;
  score: number; // 0..100 fit
  matched: string[]; // satisfied criteria (Vietnamese)
  blockers: string[]; // hard mismatches (Vietnamese); non-empty => not eligible
  eligible: boolean; // true iff no blockers
}

/** Japanese level ordering for "meets minimum" comparisons. */
const JP_LEVELS = ['none', 'n5', 'n4', 'n3', 'n2', 'n1'];

function norm(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** Map common gender spellings (vi/en) to MALE/FEMALE/'' . */
export function normalizeGender(v: string | null | undefined): string {
  const g = norm(v);
  if (g === 'male' || g === 'nam') return 'MALE';
  if (g === 'female' || g === 'nu' || g === 'nữ' || g === 'nœ¯') return 'FEMALE';
  if (g === 'nữ') return 'FEMALE';
  return '';
}

/** Best-effort numeric rank for a language level string (JLPT-aware). */
function levelRank(level: string | null | undefined): number {
  const l = norm(level).replace(/\s+/g, '');
  const jp = JP_LEVELS.indexOf(l);
  if (jp >= 0) return jp; // 0..5
  // IELTS-style "ielts5.5" -> scale to a comparable 0..6 band.
  const m = l.match(/(\d+(\.\d+)?)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return Math.min(6, n); // crude but monotonic
  }
  return 0;
}

/**
 * Score one program against a profile. Hard constraints (age, gender, budget,
 * required language level, closed/inactive) produce blockers; soft matches
 * (country, industry) add to the score. A program with any blocker is not
 * eligible (score still computed for transparency but capped).
 */
export function scoreProgram(profile: MatchProfile, program: ProgramCriteria): DestinationSuggestion {
  const matched: string[] = [];
  const blockers: string[] = [];
  let score = 0;

  // Availability (hard).
  if (program.active === false || (program.status && norm(program.status) !== 'open')) {
    blockers.push('Chương trình hiện không mở tuyển');
  }

  // Country (soft, high weight).
  if (profile.country && norm(profile.country) === norm(program.country)) {
    score += 35;
    matched.push(`Đúng thị trường mong muốn (${program.country})`);
  } else if (profile.country) {
    // Not a blocker — a consultant may still offer an alternative country.
    score += 0;
  }

  // Age (hard if out of range).
  if (typeof profile.age === 'number') {
    if (typeof program.minAge === 'number' && profile.age < program.minAge) {
      blockers.push(`Tuổi tối thiểu ${program.minAge} (ứng viên ${profile.age})`);
    } else if (typeof program.maxAge === 'number' && profile.age > program.maxAge) {
      blockers.push(`Tuổi tối đa ${program.maxAge} (ứng viên ${profile.age})`);
    } else if (program.minAge != null || program.maxAge != null) {
      score += 15;
      matched.push('Phù hợp độ tuổi');
    }
  }

  // Gender (hard if mismatched).
  const pg = normalizeGender(profile.gender);
  const rg = norm(program.gender);
  if (pg && rg && rg !== 'any') {
    if (rg.toUpperCase() === pg) {
      score += 10;
      matched.push('Phù hợp yêu cầu giới tính');
    } else {
      blockers.push(`Yêu cầu giới tính ${program.gender}`);
    }
  }

  // Industry (soft).
  const inds = (program.industries ?? []).map((i) => norm(i));
  if (profile.industry && inds.length > 0) {
    const pi = norm(profile.industry);
    if (inds.some((i) => i.includes(pi) || pi.includes(i))) {
      score += 20;
      matched.push(`Phù hợp ngành nghề (${profile.industry})`);
    }
  }

  // Language (hard if below minimum required level).
  if (program.requiredLanguage && norm(program.requiredLanguage).length > 0) {
    const needLevel = levelRank(program.minLanguageLevel);
    const haveLevel = levelRank(profile.languageLevel);
    if (needLevel > 0 && haveLevel < needLevel) {
      blockers.push(
        `Yêu cầu ${program.requiredLanguage} tối thiểu ${program.minLanguageLevel || ''}`.trim(),
      );
    } else if (needLevel > 0) {
      score += 10;
      matched.push('Đạt yêu cầu ngoại ngữ');
    }
  }

  // Budget (hard if candidate ceiling is below program floor).
  if (typeof profile.budgetVndM === 'number' && typeof program.budgetMinVndM === 'number') {
    if (profile.budgetVndM < program.budgetMinVndM) {
      blockers.push(`Ngân sách tối thiểu ~${program.budgetMinVndM} triệu`);
    } else {
      score += 10;
      matched.push('Phù hợp ngân sách');
    }
  }

  const eligible = blockers.length === 0;
  // Clamp + cap ineligible programs so eligible ones always rank above them.
  let finalScore = Math.max(0, Math.min(100, score));
  if (!eligible) finalScore = Math.min(finalScore, 40);

  return {
    programId: program.id,
    name: program.name,
    country: program.country,
    score: finalScore,
    matched,
    blockers,
    eligible,
  };
}

/**
 * Rank programs for a profile: eligible first (by score desc), then ineligible
 * (also by score desc) so a consultant sees near-misses with their blockers.
 * Deterministic tie-break by program name then id.
 */
export function matchDestinations(
  profile: MatchProfile,
  programs: readonly ProgramCriteria[],
  limit = 10,
): DestinationSuggestion[] {
  const scored = programs.map((p) => scoreProgram(profile, p));
  scored.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.programId < b.programId ? -1 : 1;
  });
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return scored.slice(0, n);
}
