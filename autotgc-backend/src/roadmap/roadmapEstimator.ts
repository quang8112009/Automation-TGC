/**
 * Roadmap_Estimator — pure, deterministic ROI estimation for the study-abroad
 * "Lộ trình Du học → Nghề nghiệp → Định cư" capability.
 *
 * Design principle (steering: numeric safety + reuse, don't duplicate):
 * - The study-cost figure is taken DIRECTLY from `scholarshipMatcher.scoreFinance`;
 *   this module NEVER recomputes cost/scholarship logic. (Requirement 16.1)
 * - Every derived metric is divide-by-zero safe: a missing required financial
 *   input OR a derived denominator of 0 yields `'INSUFFICIENT_DATA'` instead of
 *   a misleading number. (Requirements 16.4, 16.5)
 * - Career / PR-pathway guidance is grounded ONLY in the supplied
 *   `KnowledgeNote`s and is phrased as general, non-committal guidance — it
 *   never asserts or guarantees an immigration / PR outcome. (Requirement 16.3)
 * - The function is pure and deterministic: identical inputs always yield an
 *   identical estimate. (Requirement 16.2)
 *
 * The only cross-module dependency is `scholarshipMatcher` (cost reuse).
 */

import { scoreFinance } from '../partners/scholarshipMatcher';
import type { StudentFinance, ProgramFinance } from '../partners/scholarshipMatcher';
import type { KnowledgeNote, RoadmapEstimate } from './types';

/** Round to 2 decimals for stable, readable ROI values. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Whether a program actually carries usable cost data. Mirrors the filter used
 * by `scholarshipMatcher.matchScholarships` so "no cost data" is treated as
 * missing required financial input (→ `'INSUFFICIENT_DATA'`) rather than a
 * misleading 0. (Requirement 16.5)
 */
function hasCostData(program: ProgramFinance): boolean {
  return (program.tuitionPerYearVndM ?? 0) > 0 || (program.livingCostPerYearVndM ?? 0) > 0;
}

/** Keyword sets (lower-cased) used to ground notes deterministically. */
const CAREER_KEYWORDS: readonly string[] = [
  'career',
  'job',
  'employment',
  'work',
  'salary',
  'income',
  'nghề',
  'việc làm',
  'việc lam',
  'lương',
  'thu nhập',
  'tuyển dụng',
];

const PR_KEYWORDS: readonly string[] = [
  'pr',
  'permanent',
  'residen', // residency / resident / residence
  'immigrat', // immigration / immigrant
  'settle',
  'định cư',
  'dinh cu',
  'thường trú',
  'thuong tru',
  'nhập tịch',
  'visa',
];

/**
 * Select knowledge notes whose title or content matches any keyword, preserving
 * the input order (deterministic). Each matched note is rendered as grounded,
 * non-committal guidance of the form `"{title}: {content}"` — no fabricated
 * claims are added beyond the grounding text itself.
 */
function groundedNotes(knowledge: readonly KnowledgeNote[], keywords: readonly string[]): string[] {
  const out: string[] = [];
  for (const note of knowledge) {
    const haystack = `${note.title}\n${note.content}`.toLowerCase();
    if (keywords.some((kw) => haystack.includes(kw))) {
      out.push(`${note.title}: ${note.content}`);
    }
  }
  return out;
}

/**
 * Estimate the study → career → PR roadmap ROI for a (student, program) pair.
 *
 * @param student                 Student finances/academics (reused by `scoreFinance`).
 * @param program                 Program costs/scholarship policy (reused by `scoreFinance`).
 * @param knowledge               Active `Knowledge_Base` notes used to ground guidance.
 * @param expectedAnnualIncomeVndM Optional expected post-graduation annual income
 *                                 (million VND). Required for ROI; when absent the
 *                                 ROI metric is `'INSUFFICIENT_DATA'`. (Requirement 16.5)
 * @returns A deterministic {@link RoadmapEstimate}.
 */
export function estimateRoadmap(
  student: StudentFinance,
  program: ProgramFinance,
  knowledge: readonly KnowledgeNote[],
  expectedAnnualIncomeVndM?: number | null,
): RoadmapEstimate {
  // Career / PR guidance is grounded purely in the supplied knowledge notes and
  // is independent of the financial figures. (Requirement 16.3)
  const careerNotes = groundedNotes(knowledge, CAREER_KEYWORDS);
  const prPathwayNotes = groundedNotes(knowledge, PR_KEYWORDS);

  // When the program carries no usable cost data, every financial metric is
  // missing — surface INSUFFICIENT_DATA rather than a misleading 0.
  // (Requirement 16.5)
  if (!hasCostData(program)) {
    return {
      netCostPerYearVndM: 'INSUFFICIENT_DATA',
      totalCostVndM: 'INSUFFICIENT_DATA',
      roi: 'INSUFFICIENT_DATA',
      careerNotes,
      prPathwayNotes,
    };
  }

  // Reuse the existing financial core — DO NOT recompute cost logic.
  // (Requirement 16.1)
  const finance = scoreFinance(student, program);
  const netCostPerYearVndM = finance.netCostPerYearVndM;
  // Derived from the scoreFinance result (gross cost per year). No program
  // duration is available on ProgramFinance, so we never fabricate a multiplier.
  const totalCostVndM = finance.totalCostPerYearVndM;

  // ROI = expected annual income relative to annual net study cost. The net cost
  // is the denominator: a 0 (or non-finite) denominator, a missing income input,
  // or a non-finite income all yield INSUFFICIENT_DATA. (Requirements 16.4, 16.5)
  let roi: number | 'INSUFFICIENT_DATA' = 'INSUFFICIENT_DATA';
  const incomeProvided =
    expectedAnnualIncomeVndM != null && Number.isFinite(expectedAnnualIncomeVndM);
  if (incomeProvided && Number.isFinite(netCostPerYearVndM) && netCostPerYearVndM > 0) {
    const computed = (expectedAnnualIncomeVndM as number) / netCostPerYearVndM;
    roi = Number.isFinite(computed) ? round2(computed) : 'INSUFFICIENT_DATA';
  }

  return {
    netCostPerYearVndM,
    totalCostVndM,
    roi,
    careerNotes,
    prPathwayNotes,
  };
}
