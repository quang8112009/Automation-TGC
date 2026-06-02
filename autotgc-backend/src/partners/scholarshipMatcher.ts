/**
 * Scholarship_Matcher — pure financial + scholarship fit for study-abroad
 * programs. Framework-free + deterministic so it is property-testable.
 *
 * Given a student's finances/academics (ngân sách/năm, GPA, IELTS) and a
 * program's costs (tuition + living) and scholarship policy (max %, min GPA,
 * min IELTS), it computes: total cost, the estimated scholarship the student
 * could earn (scaled by how far they exceed the academic thresholds), the net
 * cost after scholarship, and whether the student's budget covers it — then
 * ranks affordable programs for the consultant.
 */

export interface StudentFinance {
  /** Family budget per year (million VND). */
  budgetPerYearVndM?: number;
  gpa?: number; // 10-scale
  ielts?: number; // 0..9
}

export interface ProgramFinance {
  id: string;
  name: string;
  country: string;
  tuitionPerYearVndM?: number | null;
  livingCostPerYearVndM?: number | null;
  scholarshipMaxPct?: number | null; // 0..100
  minGpa?: number | null;
  minIelts?: number | null;
}

export interface ScholarshipResult {
  programId: string;
  name: string;
  country: string;
  totalCostPerYearVndM: number;
  /** Estimated scholarship percentage the student could earn (0..100). */
  estScholarshipPct: number;
  estScholarshipVndM: number;
  netCostPerYearVndM: number;
  /** Shortfall vs the student's budget (>0 means budget is insufficient). */
  shortfallVndM: number;
  affordable: boolean;
  notes: string[];
}

/** Clamp a number into [lo, hi]; non-finite -> lo. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Round to 1 decimal for stable, readable money values. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Estimate the scholarship percentage a student earns at a program. The award
 * scales from 0 up to the program's `scholarshipMaxPct` based on how far the
 * student exceeds BOTH academic thresholds (GPA and IELTS). A student exactly at
 * the threshold earns a small base; well above earns closer to the max. If the
 * program sets a threshold the student misses, that dimension contributes 0.
 */
export function estimateScholarshipPct(student: StudentFinance, program: ProgramFinance): number {
  const maxPct = clamp(program.scholarshipMaxPct ?? 0, 0, 100);
  if (maxPct <= 0) return 0;

  const dims: number[] = [];

  if (program.minGpa != null) {
    const have = student.gpa ?? 0;
    if (have >= program.minGpa) {
      // headroom from minGpa..10 maps to 0..1
      const headroom = (have - program.minGpa) / Math.max(0.001, 10 - program.minGpa);
      dims.push(clamp(0.4 + 0.6 * headroom, 0, 1)); // base 0.4 at threshold
    } else {
      dims.push(0);
    }
  }

  if (program.minIelts != null) {
    const have = student.ielts ?? 0;
    if (have >= program.minIelts) {
      const headroom = (have - program.minIelts) / Math.max(0.001, 9 - program.minIelts);
      dims.push(clamp(0.4 + 0.6 * headroom, 0, 1));
    } else {
      dims.push(0);
    }
  }

  // No academic thresholds → flat half of max (merit unknown).
  if (dims.length === 0) return round1(maxPct * 0.5);

  const factor = dims.reduce((a, b) => a + b, 0) / dims.length;
  return round1(maxPct * factor);
}

/** Compute the full financial picture for one program. */
export function scoreFinance(student: StudentFinance, program: ProgramFinance): ScholarshipResult {
  const tuition = Math.max(0, program.tuitionPerYearVndM ?? 0);
  const living = Math.max(0, program.livingCostPerYearVndM ?? 0);
  const total = round1(tuition + living);

  const estPct = estimateScholarshipPct(student, program);
  const estScholarship = round1((tuition * estPct) / 100); // scholarships apply to tuition
  const net = round1(Math.max(0, total - estScholarship));

  const budget = student.budgetPerYearVndM ?? 0;
  const shortfall = round1(Math.max(0, net - budget));
  const affordable = budget > 0 ? net <= budget : false;

  const notes: string[] = [];
  if (estPct > 0) notes.push(`Ước tính học bổng ~${estPct}% học phí (≈ ${estScholarship} triệu/năm).`);
  if (program.minGpa != null && (student.gpa ?? 0) < program.minGpa) {
    notes.push(`GPA tối thiểu ${program.minGpa} để xét học bổng (hiện ${student.gpa ?? 'chưa có'}).`);
  }
  if (program.minIelts != null && (student.ielts ?? 0) < program.minIelts) {
    notes.push(`IELTS tối thiểu ${program.minIelts} để xét học bổng (hiện ${student.ielts ?? 'chưa có'}).`);
  }
  if (!affordable && budget > 0) {
    notes.push(`Còn thiếu ~${shortfall} triệu/năm so với ngân sách.`);
  } else if (affordable) {
    notes.push('Trong khả năng ngân sách.');
  }

  return {
    programId: program.id,
    name: program.name,
    country: program.country,
    totalCostPerYearVndM: total,
    estScholarshipPct: estPct,
    estScholarshipVndM: estScholarship,
    netCostPerYearVndM: net,
    shortfallVndM: shortfall,
    affordable,
    notes,
  };
}

/**
 * Rank programs for a student: affordable first (lowest net cost first), then
 * unaffordable (smallest shortfall first) so a consultant sees the closest
 * reachable options. Deterministic tie-break by name then id.
 */
export function matchScholarships(
  student: StudentFinance,
  programs: readonly ProgramFinance[],
  limit = 10,
): ScholarshipResult[] {
  const scored = programs
    // Only consider programs that actually carry cost data.
    .filter((p) => (p.tuitionPerYearVndM ?? 0) > 0 || (p.livingCostPerYearVndM ?? 0) > 0)
    .map((p) => scoreFinance(student, p));

  scored.sort((a, b) => {
    if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
    if (a.affordable) {
      if (a.netCostPerYearVndM !== b.netCostPerYearVndM) return a.netCostPerYearVndM - b.netCostPerYearVndM;
    } else {
      if (a.shortfallVndM !== b.shortfallVndM) return a.shortfallVndM - b.shortfallVndM;
    }
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.programId < b.programId ? -1 : 1;
  });

  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return scored.slice(0, n);
}
