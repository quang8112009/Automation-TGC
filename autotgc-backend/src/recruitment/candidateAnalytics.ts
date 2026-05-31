/**
 * CandidateAnalyticsService — candidate-level conversion analytics for the
 * labor-export (XKLĐ) recruitment funnel. Closes the gap where conversion was
 * only measured on raw leads: this measures the real pipeline
 * NEW -> ... -> DEPARTED ("đơn hàng -> xuất cảnh").
 *
 * SALES scoping mirrors LeadService / CandidateService (assigned-only). Pure
 * rate math lives in `computeFunnelRates` so it can be property-tested for
 * divide-by-zero safety independent of Prisma.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { isRecruitmentMarket } from './validation';
import { CANDIDATE_STAGES } from './candidateStateMachine';
import type { CandidateStage } from './candidateStateMachine';
import { ValidationError } from '../infra/errors';

/** Forward (progress) ordering of the recruitment pipeline. */
const FORWARD_ORDER: readonly CandidateStage[] = [
  'NEW',
  'CONSULTING',
  'PROFILE_COLLECTED',
  'MATCHED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_PASSED',
  'COE_VISA',
  'DEPARTED',
];

export type FunnelCounts = Record<CandidateStage, number>;

export interface FunnelRates {
  contactedRate: number;
  qualifiedRate: number;
  interviewRate: number;
  departedRate: number;
}

export interface FunnelRateResult {
  total: number;
  rates: FunnelRates;
  /** True when there were no candidates in range, so rates are not meaningful. */
  insufficient: boolean;
}

export interface FunnelFilter {
  from?: string;
  to?: string;
  market?: string;
  assignedTo?: string;
}

/** Build a zero-filled counts record covering every canonical stage. */
export function emptyFunnelCounts(): FunnelCounts {
  const counts = {} as FunnelCounts;
  for (const stage of CANDIDATE_STAGES) counts[stage] = 0;
  return counts;
}

/** Sum counts for every forward stage at or beyond `threshold`. */
function sumFrom(counts: FunnelCounts, threshold: CandidateStage): number {
  const start = FORWARD_ORDER.indexOf(threshold);
  if (start < 0) return 0;
  let sum = 0;
  for (let i = start; i < FORWARD_ORDER.length; i += 1) {
    sum += counts[FORWARD_ORDER[i]] ?? 0;
  }
  return sum;
}

/**
 * Pure, divide-by-zero-safe funnel rate math (mirrors the analytics scoring
 * convention). When the denominator (total candidates) is 0 every rate is 0 and
 * `insufficient` is true — never NaN/Infinity. Every rate is a percentage in
 * [0, 100] because each numerator is a subset of the total.
 */
export function computeFunnelRates(counts: FunnelCounts): FunnelRateResult {
  let total = 0;
  for (const stage of CANDIDATE_STAGES) {
    const c = counts[stage];
    total += typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : 0;
  }

  if (total <= 0) {
    return {
      total: 0,
      rates: { contactedRate: 0, qualifiedRate: 0, interviewRate: 0, departedRate: 0 },
      insufficient: true,
    };
  }

  const pct = (num: number): number => (num / total) * 100;

  return {
    total,
    rates: {
      contactedRate: pct(sumFrom(counts, 'CONSULTING')),
      qualifiedRate: pct(sumFrom(counts, 'PROFILE_COLLECTED')),
      interviewRate: pct(sumFrom(counts, 'INTERVIEW_SCHEDULED')),
      departedRate: pct(sumFrom(counts, 'DEPARTED')),
    },
    insufficient: false,
  };
}

export interface FunnelResult extends FunnelRateResult {
  counts: FunnelCounts;
}

export interface GroupBucket {
  key: string;
  count: number;
}

export interface JobOrderConversionBucket {
  matchedJobOrderId: string;
  total: number;
  departed: number;
  departedRate: number;
}

export class CandidateAnalyticsService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Local date-range guard (from > to => 400). */
  private assertRange(from?: string, to?: string): void {
    if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
      throw new ValidationError('date range is invalid', 'INVALID_DATE_RANGE');
    }
  }

  /** Shared createdAt range + market + SALES scoping where-clause. */
  private buildWhere(
    opts: { from?: string; to?: string; market?: string; assignedTo?: string },
    actor: AuthInfo,
  ): Prisma.CandidateProfileWhereInput {
    const where: Prisma.CandidateProfileWhereInput = {};
    if (opts.from || opts.to) {
      where.createdAt = {};
      if (opts.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(opts.from);
      if (opts.to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(opts.to);
    }
    if (opts.market !== undefined && opts.market !== '') {
      if (!isRecruitmentMarket(opts.market)) {
        throw new ValidationError(
          `Invalid desiredMarket: ${String(opts.market)}`,
          'INVALID_DESIRED_MARKET',
        );
      }
      where.desiredMarket = opts.market;
    }
    // SALES is restricted to its own assigned candidates; ADMIN may optionally
    // narrow by an explicit assignedTo.
    if (actor.role === 'SALES') {
      where.assignedTo = actor.userId;
    } else if (opts.assignedTo !== undefined && opts.assignedTo !== '') {
      where.assignedTo = opts.assignedTo;
    }
    return where;
  }

  /** Group candidates by a single scalar field, honoring the where-clause. */
  private async groupCount(
    field: 'stage' | 'desiredMarket' | 'source',
    where: Prisma.CandidateProfileWhereInput,
  ): Promise<GroupBucket[]> {
    const grouped = (await (this.prisma.candidateProfile.groupBy as unknown as (
      args: unknown,
    ) => Promise<unknown[]>)({
      by: [field],
      where,
      _count: { _all: true },
    })) as Array<Record<string, unknown> & { _count: { _all: number } }>;
    return grouped.map((g) => ({
      key: g[field] === null || g[field] === undefined ? '' : String(g[field]),
      count: g._count._all,
    }));
  }

  /**
   * Recruitment funnel: counts per CandidateStage over the range plus the
   * derived (divide-by-zero-safe) rates.
   */
  async funnel(filter: FunnelFilter, actor: AuthInfo): Promise<FunnelResult> {
    this.assertRange(filter.from, filter.to);
    const where = this.buildWhere(filter, actor);
    const buckets = await this.groupCount('stage', where);

    const counts = emptyFunnelCounts();
    for (const b of buckets) {
      if (b.key in counts) counts[b.key as CandidateStage] = b.count;
    }
    const rateResult = computeFunnelRates(counts);
    return { counts, ...rateResult };
  }

  /** Candidate counts grouped by desiredMarket over the range. */
  async byMarket(from?: string, to?: string, actor?: AuthInfo): Promise<GroupBucket[]> {
    this.assertRange(from, to);
    const where = this.buildWhere({ from, to }, this.requireActor(actor));
    return this.groupCount('desiredMarket', where);
  }

  /** Candidate counts grouped by source over the range. */
  async bySource(from?: string, to?: string, actor?: AuthInfo): Promise<GroupBucket[]> {
    this.assertRange(from, to);
    const where = this.buildWhere({ from, to }, this.requireActor(actor));
    return this.groupCount('source', where);
  }

  /**
   * Real "đơn hàng -> xuất cảnh" conversion: for each matchedJobOrderId, total
   * candidates and how many reached DEPARTED, with a divide-by-zero-safe rate.
   */
  async conversionByJobOrder(
    from?: string,
    to?: string,
    actor?: AuthInfo,
  ): Promise<JobOrderConversionBucket[]> {
    this.assertRange(from, to);
    const where = this.buildWhere({ from, to }, this.requireActor(actor));
    where.matchedJobOrderId = { not: null };

    const rows = await this.prisma.candidateProfile.findMany({
      where,
      select: { matchedJobOrderId: true, stage: true },
    });

    const agg = new Map<string, { total: number; departed: number }>();
    for (const r of rows) {
      const id = r.matchedJobOrderId;
      if (!id) continue;
      const entry = agg.get(id) ?? { total: 0, departed: 0 };
      entry.total += 1;
      if (r.stage === 'DEPARTED') entry.departed += 1;
      agg.set(id, entry);
    }

    return [...agg.entries()].map(([matchedJobOrderId, { total, departed }]) => ({
      matchedJobOrderId,
      total,
      departed,
      departedRate: total > 0 ? (departed / total) * 100 : 0,
    }));
  }

  /** Analytics endpoints always run authenticated; guard against a missing actor. */
  private requireActor(actor?: AuthInfo): AuthInfo {
    if (!actor) {
      // Defensive: routes always pass an actor. Treat absence as no scoping
      // narrowing rather than leaking data, by using an impossible SALES id.
      return { userId: '', role: 'SALES', sessionId: '' };
    }
    return actor;
  }
}
