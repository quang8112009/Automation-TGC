/**
 * Roadmap & readiness — shared types for the study-abroad-ai-advisor-suite
 * "Lộ trình Du học → Nghề nghiệp → Định cư (ROI)" capability.
 *
 * Framework-free + dependency-free so the pure cores (`roadmapEstimator`,
 * `readinessScorer`) and their property tests can import them without pulling
 * in Prisma/Fastify. (Steering: keep domain logic pure and framework-free.)
 */

/**
 * A single grounding note retrieved from the `Knowledge_Base`
 * (`KnowledgeEntry`). The `Roadmap_Estimator` grounds career and PR-pathway
 * guidance ONLY in these notes — it never fabricates immigration outcomes.
 * (Requirement 16.3)
 */
export interface KnowledgeNote {
  /** Short human-readable title of the knowledge entry. */
  title: string;
  /** Body text of the knowledge entry used for grounding. */
  content: string;
}

/**
 * Deterministic ROI estimate for a (candidate, program) pair.
 *
 * Every numeric metric is surfaced as `'INSUFFICIENT_DATA'` rather than a
 * misleading number whenever the required financial data is absent or a
 * derived denominator would be 0. (Requirements 16.4, 16.5 — numeric safety.)
 */
export interface RoadmapEstimate {
  /**
   * Net study cost per year (million VND), taken DIRECTLY from
   * `scholarshipMatcher.scoreFinance` (reused, never recomputed —
   * Requirement 16.1). `'INSUFFICIENT_DATA'` when the program carries no
   * usable cost data.
   */
  netCostPerYearVndM: number | 'INSUFFICIENT_DATA';
  /**
   * Total study cost (million VND) derived from the `scoreFinance` result.
   * `'INSUFFICIENT_DATA'` when the program carries no usable cost data.
   */
  totalCostVndM: number | 'INSUFFICIENT_DATA';
  /**
   * Return-on-investment proxy (expected annual income relative to annual net
   * cost). `'INSUFFICIENT_DATA'` when any required financial input is missing
   * or the derived denominator is 0. (Requirements 16.4, 16.5)
   */
  roi: number | 'INSUFFICIENT_DATA';
  /**
   * Post-graduation career guidance, grounded ONLY in the supplied
   * `KnowledgeNote`s and phrased as general, non-committal guidance.
   * (Requirement 16.3)
   */
  careerNotes: string[];
  /**
   * Residency / immigration ("PR") pathway guidance, grounded ONLY in the
   * supplied `KnowledgeNote`s. MUST NOT assert or guarantee any immigration /
   * PR outcome. (Requirement 16.3)
   */
  prPathwayNotes: string[];
}
