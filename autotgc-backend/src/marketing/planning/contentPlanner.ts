/**
 * Content_Planner — market content planning for Vietnamese labor-export (XKLĐ).
 *
 * Turns reviewed market trends + the analytics AI_Prompt_Context into a concrete,
 * multi-channel ContentPlan (kế hoạch nội dung) with evenly-spread ContentPlanItems.
 *
 * Design principles (match research/trendResearchService.ts + content/generationService.ts):
 *   - Gemini is OPTIONAL. The deterministic distributor is the DEFAULT path and
 *     always produces a non-empty plan. When a key is configured we MAY ask the
 *     model to reorder the slots, but ANY failure (unconfigured 502, network,
 *     bad/unparseable response) is tolerated and falls back to the deterministic
 *     order. We NEVER throw for missing AI.
 *   - Analytics-biased, not volume-driven (per product goal): trends that match
 *     `topPerformingTopics` rank first and any trend matching an `avoidTopics`
 *     entry is dropped — cold-start safe (empty/missing context changes nothing).
 *   - Trend sourcing is preference-ordered: ADOPTED signals first, else the top
 *     DISCOVERED signals, else a deterministic heuristic seed set so planning
 *     never produces an empty plan.
 *   - `defaultChannelFormatMatrix` and `distributePlanItems` are PURE and
 *     exported for property testing. Status changes go through a guarded
 *     transition (409 on illegal moves), mirroring the project's *Machine convention.
 */
import type { ContentPlan, ContentPlanItem, PrismaClient, TrendSignal } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../infra/errors';
import { isRecord, asString } from '../../platforms/narrow';
import type { ContentGenerator } from '../../strategy/personaService';
import { stripCodeFences } from '../../strategy/personaService';
import { PrismaAiPromptContextReader } from '../../content/generationService';
import type { PerformanceContext } from '../../content/generationService';
import { isMarket, marketLabel } from '../markets';
import type { Market } from '../markets';
import type { BrandKnowledgeProvider } from '../brandKnowledge';
import { TrendResearchService, heuristicTrends } from '../research/trendResearchService';

/** Channels the planner distributes content across. */
export type Channel = 'facebook' | 'tiktok' | 'youtube' | 'website' | 'zalo' | 'email';
export const CHANNELS: readonly Channel[] = [
  'facebook',
  'tiktok',
  'youtube',
  'website',
  'zalo',
  'email',
] as const;
const CHANNEL_SET: ReadonlySet<string> = new Set<string>(CHANNELS);

/** Content formats a plan item can take (mirrors ContentDraft.format vocabulary). */
export type ContentFormat =
  | 'SEO_ARTICLE'
  | 'FANPAGE_CAPTION'
  | 'VIDEO_SCRIPT'
  | 'EMAIL'
  | 'CARE_MESSAGE'
  | 'CHATBOT_FAQ';
export const CONTENT_FORMATS: readonly ContentFormat[] = [
  'SEO_ARTICLE',
  'FANPAGE_CAPTION',
  'VIDEO_SCRIPT',
  'EMAIL',
  'CARE_MESSAGE',
  'CHATBOT_FAQ',
] as const;
const FORMAT_SET: ReadonlySet<string> = new Set<string>(CONTENT_FORMATS);

/** Plan-level objective (mirrors generationService Objective). */
export type PlanObjective = 'Lead' | 'View' | 'Follow';
const OBJECTIVES: ReadonlySet<string> = new Set<PlanObjective>(['Lead', 'View', 'Follow']);

/** Plan-item lifecycle status. */
export type PlanItemStatus = 'PLANNED' | 'GENERATED' | 'SCHEDULED' | 'PUBLISHED' | 'SKIPPED';
const ITEM_STATUSES: ReadonlySet<string> = new Set<PlanItemStatus>([
  'PLANNED',
  'GENERATED',
  'SCHEDULED',
  'PUBLISHED',
  'SKIPPED',
]);

/** Plan lifecycle status (mirrors Prisma enum ContentPlanStatus). */
export type PlanStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

/** A {channel, format} pair the distributor round-robins over. */
export interface ChannelFormat {
  channel: Channel;
  format: ContentFormat;
}

/**
 * Minimal trend shape the distributor needs. `id` is optional because heuristic
 * seeds are not persisted TrendSignals; when present it is carried onto the item
 * as `trendId`. `demandScore` drives the analytics ranking bias.
 */
export interface PlanTrendInput {
  id?: string | null;
  topic: string;
  keyword: string;
  demandScore?: number;
}

/** A deterministic plan-item spec produced by `distributePlanItems`. */
export interface PlanItemSpec {
  market?: string;
  channel: Channel;
  format: ContentFormat;
  topic: string;
  keyword: string;
  objective: PlanObjective;
  targetDate: Date;
  trendId: string | null;
  orderIndex: number;
}

export interface GeneratePlanInput {
  market: string;
  objective: string;
  periodFrom: Date | string;
  periodTo: Date | string;
  /** Optional channel allow-list; restricts the default matrix when provided. */
  channels?: string[];
  createdBy?: string | null;
}

/** A ContentPlan with its items eagerly included (ordered by orderIndex). */
export type ContentPlanWithItems = ContentPlan & { items: ContentPlanItem[] };

/** How many top DISCOVERED signals to fall back to when none are ADOPTED. */
const TOP_DISCOVERED_N = 8;

/** Allowed plan status transitions (terminal: ARCHIVED). */
export const PLAN_TRANSITIONS: ReadonlyArray<readonly [PlanStatus, PlanStatus]> = [
  ['DRAFT', 'ACTIVE'],
  ['DRAFT', 'ARCHIVED'],
  ['ACTIVE', 'ARCHIVED'],
];

export type PlanTransitionResult = { ok: true; status: PlanStatus } | { ok: false; status: 409 };

/** Pure guarded transition; 409 on an illegal move. */
export function planTransition(current: PlanStatus, target: PlanStatus): PlanTransitionResult {
  const allowed = PLAN_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}

/** Narrow an unknown to a PlanObjective. */
export function isPlanObjective(v: unknown): v is PlanObjective {
  return typeof v === 'string' && OBJECTIVES.has(v);
}

/** Narrow an unknown to a PlanItemStatus. */
export function isPlanItemStatus(v: unknown): v is PlanItemStatus {
  return typeof v === 'string' && ITEM_STATUSES.has(v);
}

/**
 * Pure, deterministic channel→format matrix. Spans every channel
 * (facebook|tiktok|youtube|website|zalo|email) and every format
 * (SEO_ARTICLE|FANPAGE_CAPTION|VIDEO_SCRIPT|EMAIL|CARE_MESSAGE|CHATBOT_FAQ):
 *   website  → SEO_ARTICLE        (long-form SEO)
 *   facebook → FANPAGE_CAPTION    (fanpage post)
 *   tiktok   → VIDEO_SCRIPT       (short video)
 *   youtube  → VIDEO_SCRIPT       (long video)
 *   email    → EMAIL              (nurture mail)
 *   zalo     → CARE_MESSAGE       (care / re-engagement)
 *   website  → CHATBOT_FAQ        (FAQ for the site chatbot)
 */
export function defaultChannelFormatMatrix(): ChannelFormat[] {
  return [
    { channel: 'website', format: 'SEO_ARTICLE' },
    { channel: 'facebook', format: 'FANPAGE_CAPTION' },
    { channel: 'tiktok', format: 'VIDEO_SCRIPT' },
    { channel: 'youtube', format: 'VIDEO_SCRIPT' },
    { channel: 'email', format: 'EMAIL' },
    { channel: 'zalo', format: 'CARE_MESSAGE' },
    { channel: 'website', format: 'CHATBOT_FAQ' },
  ];
}

/**
 * Pure, deterministic plan-item distribution. Produces one spec per matrix slot,
 * round-robining the matrix and cycling through `trends` to tie each item to a
 * trend. Target dates are spread EVENLY across [from, to]; when there is more
 * than one item the first lands exactly on `from` and the last exactly on `to`.
 *
 * Deterministic: identical inputs always yield identical output.
 */
export function distributePlanItems(
  trends: PlanTrendInput[],
  matrix: ChannelFormat[],
  period: { from: Date; to: Date },
  objective: PlanObjective,
): PlanItemSpec[] {
  const count = matrix.length;
  const fromMs = period.from.getTime();
  const toMs = period.to.getTime();

  const specs: PlanItemSpec[] = [];
  for (let i = 0; i < count; i++) {
    const slot = matrix[i];
    const trend = trends.length > 0 ? trends[i % trends.length] : undefined;
    specs.push({
      channel: slot.channel,
      format: slot.format,
      topic: trend?.topic ?? '',
      keyword: trend?.keyword ?? '',
      objective,
      targetDate: spreadDate(fromMs, toMs, i, count),
      trendId: trend?.id ?? null,
      orderIndex: i,
    });
  }
  return specs;
}

/** Evenly spread item `i` of `count` across [fromMs, toMs] (endpoints exact). */
function spreadDate(fromMs: number, toMs: number, i: number, count: number): Date {
  if (count <= 1) return new Date(fromMs);
  const ratio = i / (count - 1);
  return new Date(Math.round(fromMs + (toMs - fromMs) * ratio));
}

export class ContentPlanner {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gemini?: ContentGenerator,
    /**
     * Optional brand-knowledge grounding seam. When present, the optional Gemini
     * reorder prompt is grounded in Thanh Giang facts (consistency only — it
     * NEVER changes the deterministic distribution). Absent leaves it unchanged.
     */
    private readonly brandKnowledge?: BrandKnowledgeProvider,
  ) {}

  /**
   * Generate a DRAFT ContentPlan for a market + period. Sources trends
   * (ADOPTED → top DISCOVERED → heuristic), applies the analytics bias, then
   * deterministically distributes items across the channel/format matrix. A
   * Gemini reorder is attempted only when configured and is fully optional.
   */
  async generatePlan(input: GeneratePlanInput): Promise<ContentPlanWithItems> {
    if (!isMarket(input.market)) {
      throw new ValidationError('Unknown market', 'PLAN_MARKET_INVALID');
    }
    if (!isPlanObjective(input.objective)) {
      throw new ValidationError('Objective must be one of Lead, View, Follow', 'PLAN_OBJECTIVE_INVALID');
    }
    const market = input.market;
    const objective = input.objective;
    const from = coerceDate(input.periodFrom, 'PLAN_PERIOD_FROM_INVALID');
    const to = coerceDate(input.periodTo, 'PLAN_PERIOD_TO_INVALID');
    // Guard the range so item target dates never run backwards (mirrors the
    // autopilotService.run() AUTOPILOT_PERIOD_RANGE_INVALID guard). spreadDate
    // would otherwise place item 0 at the later date and later items before
    // periodFrom when to < from.
    if (to.getTime() < from.getTime()) {
      throw new ValidationError(
        'periodTo must be on or after periodFrom',
        'PLAN_PERIOD_RANGE_INVALID',
      );
    }

    let trends = await this.resolveTrends(market);

    // Analytics bias (cold-start safe): drop avoided topics, rank performers first.
    let ctx: PerformanceContext | null = null;
    try {
      ctx = await new PrismaAiPromptContextReader(this.prisma).get();
    } catch {
      ctx = null;
    }
    const topTopics = toStringList(ctx?.topPerformingTopics);
    const avoidTopics = toStringList(ctx?.avoidTopics);
    trends = applyAnalyticsBias(trends, topTopics, avoidTopics);

    // Guarantee a non-empty plan even if the bias filtered everything out.
    if (trends.length === 0) {
      trends = seedsToPlanTrends(heuristicTrends(market));
    }

    const matrix = resolveMatrix(input.channels);
    let specs = distributePlanItems(trends, matrix, { from, to }, objective);
    specs = await this.maybeReorder(specs, market, from, to);

    const plan = await this.prisma.contentPlan.create({
      data: {
        market,
        title: defaultPlanTitle(market, from, to),
        objective,
        periodFrom: from,
        periodTo: to,
        status: 'DRAFT',
        notes: '',
        createdBy: input.createdBy ?? null,
        items: {
          create: specs.map((s) => ({
            market,
            channel: s.channel,
            format: s.format,
            topic: s.topic,
            keyword: s.keyword,
            objective: s.objective,
            targetDate: s.targetDate,
            trendId: s.trendId,
            orderIndex: s.orderIndex,
            status: 'PLANNED',
          })),
        },
      },
      include: { items: { orderBy: { orderIndex: 'asc' } } },
    });
    return plan;
  }

  /** Source trends: ADOPTED first, else top DISCOVERED, else heuristic seeds. */
  private async resolveTrends(market: Market): Promise<PlanTrendInput[]> {
    const research = new TrendResearchService(this.prisma);

    const adopted = await research.adoptedTopics(market);
    if (adopted.length > 0) {
      return signalsToPlanTrends(adopted);
    }

    const discovered = (await research.list(market))
      .filter((s) => s.status === 'DISCOVERED')
      .slice(0, TOP_DISCOVERED_N);
    if (discovered.length > 0) {
      return signalsToPlanTrends(discovered);
    }

    return seedsToPlanTrends(heuristicTrends(market));
  }

  /**
   * Optional Gemini reorder of the slots. Deterministic distribution is the
   * default; when a key is configured we ask for a permutation of slot indices
   * and apply it ONLY if it is a valid full permutation. Any failure (missing
   * AI, network, bad response) is swallowed and the original order is kept.
   */
  private async maybeReorder(
    specs: PlanItemSpec[],
    market: Market,
    from: Date,
    to: Date,
  ): Promise<PlanItemSpec[]> {
    if (!this.gemini || specs.length < 2) return specs;
    try {
      // Optional brand grounding (never throws); prepended to the reorder prompt.
      const grounding = this.brandKnowledge
        ? await this.brandKnowledge.groundingBlock({ market })
        : undefined;
      const text = await this.gemini.generateContent(buildReorderPrompt(market, specs, grounding));
      const order = parsePermutation(text, specs.length);
      if (!order) return specs;
      return reorderSpecs(specs, order, from, to);
    } catch {
      return specs; // tolerate any AI failure — deterministic order stands.
    }
  }

  /** DRAFT → ACTIVE. 404 if missing; 409 on an illegal/terminal transition. */
  async activate(planId: string): Promise<ContentPlan> {
    return this.transition(planId, 'ACTIVE');
  }

  /** DRAFT|ACTIVE → ARCHIVED. 404 if missing; 409 on an illegal transition. */
  async archive(planId: string): Promise<ContentPlan> {
    return this.transition(planId, 'ARCHIVED');
  }

  private async transition(planId: string, target: PlanStatus): Promise<ContentPlan> {
    const plan = await this.prisma.contentPlan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundError('Content plan not found', 'PLAN_NOT_FOUND');
    }
    const result = planTransition(plan.status as PlanStatus, target);
    if (!result.ok) {
      throw new ConflictError(
        `Cannot move plan from ${plan.status} to ${target}`,
        'PLAN_TRANSITION_INVALID',
      );
    }
    return this.prisma.contentPlan.update({
      where: { id: planId },
      data: { status: target },
    });
  }

  /** Fetch a plan with its items ordered by orderIndex. 404 if missing. */
  async get(planId: string): Promise<ContentPlanWithItems> {
    const plan = await this.prisma.contentPlan.findUnique({
      where: { id: planId },
      include: { items: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!plan) {
      throw new NotFoundError('Content plan not found', 'PLAN_NOT_FOUND');
    }
    return plan;
  }

  /** List plans, optionally filtered by market and/or status (newest first). */
  async list(market?: string, status?: string): Promise<ContentPlan[]> {
    const where: { market?: string; status?: PlanStatus } = {};
    if (market !== undefined && isMarket(market)) where.market = market;
    if (status !== undefined && isPlanStatus(status)) where.status = status;
    return this.prisma.contentPlan.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** List a plan's items ordered by orderIndex. */
  async listItems(planId: string): Promise<ContentPlanItem[]> {
    return this.prisma.contentPlanItem.findMany({
      where: { planId },
      orderBy: { orderIndex: 'asc' },
    });
  }

  /**
   * Set a plan item's status (and optional generated draftId). 400 for an
   * invalid status; 404 when the item is missing.
   */
  async markItem(itemId: string, status: string, draftId?: string): Promise<ContentPlanItem> {
    if (!isPlanItemStatus(status)) {
      throw new ValidationError('Invalid plan item status', 'PLAN_ITEM_STATUS_INVALID');
    }
    const item = await this.prisma.contentPlanItem.findUnique({ where: { id: itemId } });
    if (!item) {
      throw new NotFoundError('Plan item not found', 'PLAN_ITEM_NOT_FOUND');
    }
    const data: { status: PlanItemStatus; draftId?: string } = { status };
    if (draftId !== undefined && draftId.trim().length > 0) {
      data.draftId = draftId.trim();
    }
    return this.prisma.contentPlanItem.update({ where: { id: itemId }, data });
  }
}

// ---- Pure helpers -----------------------------------------------------------

/** Narrow an unknown string to a PlanStatus. */
export function isPlanStatus(v: unknown): v is PlanStatus {
  return v === 'DRAFT' || v === 'ACTIVE' || v === 'ARCHIVED';
}

/** Restrict the default matrix to an optional channel allow-list (else full). */
function resolveMatrix(channels?: string[]): ChannelFormat[] {
  const full = defaultChannelFormatMatrix();
  if (!Array.isArray(channels) || channels.length === 0) return full;
  const allow = new Set(channels.filter((c): c is string => typeof c === 'string'));
  const filtered = full.filter((m) => allow.has(m.channel));
  return filtered.length > 0 ? filtered : full;
}

/** Map persisted TrendSignals to the distributor's minimal trend shape. */
function signalsToPlanTrends(signals: TrendSignal[]): PlanTrendInput[] {
  return signals.map((s) => ({
    id: s.id,
    topic: s.topic || s.keyword,
    keyword: s.keyword,
    demandScore: s.demandScore,
  }));
}

/** Map heuristic seeds (no persisted id) to the distributor's trend shape. */
function seedsToPlanTrends(seeds: ReadonlyArray<{ topic: string; keyword: string; demandScore: number }>): PlanTrendInput[] {
  return seeds.map((s) => ({
    id: null,
    topic: s.topic || s.keyword,
    keyword: s.keyword,
    demandScore: s.demandScore,
  }));
}

/**
 * Apply the analytics bias: drop any trend matching an avoidTopics entry, then
 * stable-sort so topPerformingTopics-adjacent trends rank first, breaking ties
 * by demand score (desc) and original order. Cold-start safe: empty lists leave
 * ranking driven purely by demand score.
 */
export function applyAnalyticsBias(
  trends: PlanTrendInput[],
  topTopics: string[],
  avoidTopics: string[],
): PlanTrendInput[] {
  const kept = trends.filter((t) => !matchesAny(t, avoidTopics));
  return kept
    .map((t, i) => ({
      t,
      i,
      boost: matchesAny(t, topTopics) ? 1 : 0,
      score: typeof t.demandScore === 'number' ? t.demandScore : 0,
    }))
    .sort((a, b) => b.boost - a.boost || b.score - a.score || a.i - b.i)
    .map((x) => x.t);
}

/** True when a trend's topic/keyword matches any (non-empty) needle (substring, case-insensitive). */
function matchesAny(trend: PlanTrendInput, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const topic = trend.topic.toLowerCase();
  const keyword = trend.keyword.toLowerCase();
  for (const raw of needles) {
    const n = raw.trim().toLowerCase();
    if (n.length === 0) continue;
    // Guard the reverse-substring checks against empty topic/keyword: in JS
    // `"x".includes("")` is true, so without these guards an empty field would
    // match every needle (always dropped by avoidTopics / always boosted).
    if (
      topic.includes(n) ||
      keyword.includes(n) ||
      (keyword.length > 0 && n.includes(keyword)) ||
      (topic.length > 0 && n.includes(topic))
    ) {
      return true;
    }
  }
  return false;
}

/** Extract a lowercased string list from an unknown Json value (cold-start safe). */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      out.push(entry.trim().toLowerCase());
    } else if (isRecord(entry)) {
      const s =
        asString(entry.topic) ??
        asString(entry.name) ??
        asString(entry.keyword) ??
        asString(entry.label);
      if (s) out.push(s.trim().toLowerCase());
    }
  }
  return out;
}

/** A deterministic Vietnamese plan title for a market + period. */
function defaultPlanTitle(market: Market, from: Date, to: Date): string {
  const f = from.toISOString().slice(0, 10);
  const t = to.toISOString().slice(0, 10);
  return `Kế hoạch nội dung ${marketLabel(market)} (${f} → ${t})`;
}

/** Coerce a Date|string to a valid Date or throw a 400. */
function coerceDate(value: Date | string, code: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('Invalid date', code);
  }
  return d;
}

/** Build the (optional) Gemini reorder prompt. */
function buildReorderPrompt(market: Market, specs: PlanItemSpec[], grounding?: string): string {
  const lines = specs.map(
    (s, i) => `${i}: [${s.channel}/${s.format}] ${s.topic || s.keyword}`,
  );
  const head = grounding && grounding.trim().length > 0 ? [grounding.trim()] : [];
  return [
    ...head,
    `[Role] You are a content strategist for Vietnamese labor-export to ${marketLabel(market)}.`,
    '[Task] Reorder the following content slots for the best publishing sequence.',
    ...lines,
    `[Output] Respond ONLY with a JSON array of ${specs.length} integers that is a`,
    'permutation of 0-based slot indices, e.g. [2,0,1,...]. No commentary.',
  ].join('\n');
}

/** Parse a permutation of [0, n) from a model response; null if invalid. */
export function parsePermutation(text: string, n: number): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(text ?? ''));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== n) return null;
  const order: number[] = [];
  const seen = new Set<number>();
  for (const raw of parsed) {
    const idx = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= n || seen.has(idx)) return null;
    seen.add(idx);
    order.push(idx);
  }
  return order;
}

/**
 * Reorder specs by a permutation, re-deriving orderIndex and re-spreading
 * targetDates by the new position so the even [from, to] distribution invariant
 * is preserved regardless of the reordering.
 */
export function reorderSpecs(
  specs: PlanItemSpec[],
  order: number[],
  from: Date,
  to: Date,
): PlanItemSpec[] {
  const count = specs.length;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return order.map((srcIndex, position) => ({
    ...specs[srcIndex],
    orderIndex: position,
    targetDate: spreadDate(fromMs, toMs, position, count),
  }));
}
