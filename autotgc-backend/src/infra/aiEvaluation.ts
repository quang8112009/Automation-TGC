/**
 * Evaluation harness for AI text output (harness layer: Evaluation).
 *
 * Pure, framework-free scoring so AI output quality can be measured and so two
 * providers (e.g. the previous Gemini gateway vs. DeepSeek V4) can be compared
 * for PARITY before/after the migration. Everything here is deterministic and
 * numeric-safe (no divide-by-zero; empty inputs report `INSUFFICIENT_DATA`),
 * which makes it directly property-testable with fast-check.
 *
 * It evaluates STRUCTURE and GROUNDING, not "truth": an output scores well when
 * it is non-empty, of reasonable length, and mentions the expected grounded
 * keywords (e.g. program name, country) — never by calling another model. This
 * keeps evaluation cheap, offline, and reproducible. An optional LLM-as-judge
 * can be layered on top later via the same `EvalScore` shape.
 */

/** A single evaluation case: a grounded expectation for one generated output. */
export interface EvalCase {
  /** Stable id of the case (for reporting). */
  id: string;
  /** The model output text to score. */
  output: string;
  /**
   * Keywords that a well-grounded output should contain (case-insensitive,
   * substring match). E.g. the program name / country the prompt was grounded in.
   */
  expectedKeywords: readonly string[];
  /** Minimum acceptable output length in characters (default 1). */
  minChars?: number;
  /** Maximum acceptable output length in characters (default Infinity). */
  maxChars?: number;
}

/** Score for one evaluation case, every component in [0,1]. */
export interface EvalScore {
  id: string;
  /** 1 when output is non-empty after trim, else 0. */
  nonEmpty: number;
  /** Fraction of `expectedKeywords` present (case-insensitive). 1 when none expected. */
  groundingCoverage: number;
  /** 1 when length is within [minChars, maxChars], else 0. */
  lengthCompliance: number;
  /** Equally-weighted mean of the three components, always in [0,1]. */
  overall: number;
}

/** Clamp a number into [0,1]; non-finite → 0. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Score one evaluation case. Deterministic and pure. Grounding coverage is the
 * fraction of expected keywords found as a case-insensitive substring; with no
 * expected keywords coverage is 1 (nothing to miss). Length compliance is a
 * hard pass/fail against [minChars, maxChars].
 */
export function scoreEvalCase(testCase: EvalCase): EvalScore {
  const text = typeof testCase.output === 'string' ? testCase.output : '';
  const trimmed = text.trim();
  const nonEmpty = trimmed.length > 0 ? 1 : 0;

  const haystack = text.toLowerCase();
  const keywords = testCase.expectedKeywords ?? [];
  let coverage: number;
  if (keywords.length === 0) {
    coverage = 1;
  } else {
    let hit = 0;
    for (const kw of keywords) {
      const needle = (kw ?? '').toLowerCase().trim();
      if (needle.length > 0 && haystack.includes(needle)) hit += 1;
    }
    coverage = hit / keywords.length;
  }

  const minChars = Number.isFinite(testCase.minChars) ? (testCase.minChars as number) : 1;
  const maxChars = Number.isFinite(testCase.maxChars) ? (testCase.maxChars as number) : Number.POSITIVE_INFINITY;
  const len = text.length;
  const lengthCompliance = len >= minChars && len <= maxChars ? 1 : 0;

  const overall = clamp01((nonEmpty + clamp01(coverage) + lengthCompliance) / 3);
  return {
    id: testCase.id,
    nonEmpty,
    groundingCoverage: clamp01(coverage),
    lengthCompliance,
    overall,
  };
}

/** Aggregate report over a batch of evaluation cases. */
export interface EvalReport {
  caseCount: number;
  /** Mean overall score across cases — `INSUFFICIENT_DATA` when no cases. */
  meanOverall: number | 'INSUFFICIENT_DATA';
  /** Fraction of cases meeting `passThreshold` — `INSUFFICIENT_DATA` when no cases. */
  passRate: number | 'INSUFFICIENT_DATA';
  /** Per-case scores in input order. */
  scores: EvalScore[];
}

/**
 * Evaluate a batch of cases and aggregate. Numeric-safe: an empty batch yields
 * `INSUFFICIENT_DATA` for mean/pass-rate. `passThreshold` defaults to 0.7 and is
 * clamped to [0,1].
 */
export function evaluateBatch(cases: readonly EvalCase[], passThreshold = 0.7): EvalReport {
  const threshold = clamp01(passThreshold);
  const scores = cases.map(scoreEvalCase);
  if (scores.length === 0) {
    return { caseCount: 0, meanOverall: 'INSUFFICIENT_DATA', passRate: 'INSUFFICIENT_DATA', scores: [] };
  }
  const sum = scores.reduce((acc, s) => acc + s.overall, 0);
  const passed = scores.filter((s) => s.overall >= threshold).length;
  return {
    caseCount: scores.length,
    meanOverall: sum / scores.length,
    passRate: passed / scores.length,
    scores,
  };
}

/** Result of comparing two providers' outputs on the same cases (parity check). */
export interface ParityResult {
  caseCount: number;
  /** Mean overall score of provider A — `INSUFFICIENT_DATA` when no cases. */
  meanA: number | 'INSUFFICIENT_DATA';
  /** Mean overall score of provider B — `INSUFFICIENT_DATA` when no cases. */
  meanB: number | 'INSUFFICIENT_DATA';
  /**
   * `meanB - meanA` (positive ⇒ B is better). `INSUFFICIENT_DATA` when either
   * side has no cases.
   */
  delta: number | 'INSUFFICIENT_DATA';
  /**
   * True when B does NOT regress beyond `tolerance` below A
   * (i.e. `meanB >= meanA - tolerance`). When there are no cases, parity holds
   * vacuously (`true`).
   */
  withinTolerance: boolean;
}

/**
 * Compare two providers on the SAME ordered set of cases (A = baseline/previous
 * provider, B = candidate/DeepSeek). Pure + deterministic. `tolerance` (default
 * 0.05, clamped to [0,1]) is how much mean-score regression is acceptable. Use
 * this to gate the migration: B passes parity when `withinTolerance` is true.
 */
export function compareProviderParity(
  outputsA: readonly EvalCase[],
  outputsB: readonly EvalCase[],
  tolerance = 0.05,
): ParityResult {
  const tol = clamp01(tolerance);
  const a = evaluateBatch(outputsA);
  const b = evaluateBatch(outputsB);

  if (a.meanOverall === 'INSUFFICIENT_DATA' || b.meanOverall === 'INSUFFICIENT_DATA') {
    return {
      caseCount: Math.max(a.caseCount, b.caseCount),
      meanA: a.meanOverall,
      meanB: b.meanOverall,
      delta: 'INSUFFICIENT_DATA',
      withinTolerance: true, // vacuously true with no data to compare
    };
  }

  const delta = b.meanOverall - a.meanOverall;
  return {
    caseCount: Math.max(a.caseCount, b.caseCount),
    meanA: a.meanOverall,
    meanB: b.meanOverall,
    delta,
    withinTolerance: b.meanOverall >= a.meanOverall - tol,
  };
}
