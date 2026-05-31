/**
 * Trend_Research_Service — AI-assisted (Gemini-optional) market trend / keyword /
 * high-demand-topic discovery for Vietnamese labor-export (XKLĐ), grounded in
 * Thanh Giang's target markets (Japan, Korea, Germany, Taiwan, Australia,
 * Lithuania, Europe, ...).
 *
 * Design principles (match content/generationService.ts):
 *   - Gemini is OPTIONAL. When a key is configured we ask the model for a JSON
 *     array of demand signals and parse it tolerantly (stripCodeFences pattern).
 *     On ANY failure — unconfigured (502 AI_NOT_CONFIGURED), network error, or an
 *     unparseable/empty response — we fall back to a DETERMINISTIC heuristic seed
 *     set grounded in known XKLĐ demand and flag `aiGenerated: false`. We NEVER
 *     throw for missing AI.
 *   - `buildResearchPrompt`, `parseTrends`, and `heuristicTrends` are pure and
 *     exported for property testing.
 *   - Status changes go through a guarded transition (409 on illegal moves),
 *     mirroring the project's *StateMachine convention.
 */
import type { Prisma, PrismaClient, TrendSignal } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../infra/errors';
import { isRecord, asString, asNumberOrNull } from '../../platforms/narrow';
import { stripCodeFences } from '../../strategy/personaService';
import type { ContentGenerator } from '../../strategy/personaService';
import { isMarket, marketLabel } from '../markets';
import type { Market } from '../markets';
import type { BrandKnowledgeProvider } from '../brandKnowledge';

/** Trend lifecycle status (mirrors Prisma enum TrendStatus). */
export type TrendStatus = 'DISCOVERED' | 'REVIEWED' | 'ADOPTED' | 'DISMISSED';

/** A single demand signal as proposed by the model or the heuristic seed set. */
export interface TrendSeed {
  keyword: string;
  topic: string;
  intent: string;
  demandScore: number; // 0..100
  rationale: string;
}

export interface ResearchResult {
  created: TrendSignal[];
  aiGenerated: boolean;
}

export interface ResearchOptions {
  /** Optional sources to attach to every persisted signal (e.g. provenance). */
  sources?: unknown[];
}

/** Allowed trend status transitions (terminal: ADOPTED, DISMISSED). */
export const TREND_TRANSITIONS: ReadonlyArray<readonly [TrendStatus, TrendStatus]> = [
  ['DISCOVERED', 'REVIEWED'],
  ['DISCOVERED', 'ADOPTED'],
  ['DISCOVERED', 'DISMISSED'],
  ['REVIEWED', 'ADOPTED'],
  ['REVIEWED', 'DISMISSED'],
];

/** Targets a reviewer may move a signal to (DISCOVERED is discovery-only). */
const REVIEW_TARGETS: ReadonlySet<string> = new Set<TrendStatus>(['REVIEWED', 'ADOPTED', 'DISMISSED']);

export type TrendTransitionResult =
  | { ok: true; status: TrendStatus }
  | { ok: false; status: 409 };

/** Pure guarded transition; 409 on an illegal move. */
export function trendTransition(current: TrendStatus, target: TrendStatus): TrendTransitionResult {
  const allowed = TREND_TRANSITIONS.some(([a, b]) => a === current && b === target);
  return allowed ? { ok: true, status: target } : { ok: false, status: 409 };
}

/** Clamp any unknown numeric to the inclusive demand-score band [0, 100]. */
export function clampDemandScore(value: unknown): number {
  const n = asNumberOrNull(value);
  if (n === null) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

/**
 * Pure, deterministic research prompt. Asks the model for high-demand keywords,
 * topics and search intents (salary, visa, eligibility, cost, industries) for
 * labor-export to the given market, and pins the JSON response shape.
 *
 * `grounding` is passed IN (not fetched here) so the builder stays pure. When
 * provided it is prepended verbatim as the FIRST segment so the model researches
 * grounded in Thanh Giang's brand facts. When omitted the prompt is
 * byte-identical to the pre-grounding behavior.
 */
export function buildResearchPrompt(market: Market, grounding?: string): string {
  const label = marketLabel(market);
  const head = grounding && grounding.trim().length > 0 ? [grounding.trim()] : [];
  return [
    ...head,
    '[Role] You are a market-research analyst for a Vietnamese labor-export (XKLĐ) company.',
    `[Market] Research current high-demand interest for working / labor-export to ${label} (code: ${market}).`,
    '[Goal] Identify the keywords, topics and search intents Vietnamese workers actively look for.',
    '[Intents] Cover these intent categories: salary, visa, eligibility, cost, industries.',
    '[Output] Respond ONLY with a JSON array. Each element is an object with keys:',
    '  "keyword" (string), "topic" (string), "intent" (one of salary|visa|eligibility|cost|industries),',
    '  "demandScore" (number 0-100 estimated demand), "rationale" (short string).',
    '[Constraint] Return between 5 and 12 elements. Do not include commentary outside the JSON.',
  ].join('\n');
}

/**
 * Tolerant parse of a model response into TrendSeed[] (Req: parse JSON array).
 * Accepts a bare array or an object wrapping it under "trends"/"items"/"data".
 * Drops entries without a usable keyword; clamps demandScore to [0,100]. Returns
 * an empty array (never throws) when nothing usable can be extracted.
 */
export function parseTrends(text: string): TrendSeed[] {
  const cleaned = stripCodeFences(text ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const rows = extractRows(parsed);
  const seeds: TrendSeed[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const keyword = asString(row.keyword) ?? asString(row.term);
    if (!keyword) continue;
    seeds.push({
      keyword: keyword.trim(),
      topic: (asString(row.topic) ?? keyword).trim(),
      intent: normalizeIntent(asString(row.intent)),
      demandScore: clampDemandScore(row.demandScore ?? row.score),
      rationale: (asString(row.rationale) ?? '').trim(),
    });
  }
  return seeds;
}

function extractRows(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed)) {
    for (const key of ['trends', 'items', 'data', 'results']) {
      const v = parsed[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

const KNOWN_INTENTS: ReadonlySet<string> = new Set([
  'salary',
  'visa',
  'eligibility',
  'cost',
  'industries',
]);

function normalizeIntent(value: string | undefined): string {
  if (!value) return 'industries';
  const lower = value.trim().toLowerCase();
  return KNOWN_INTENTS.has(lower) ? lower : 'industries';
}

/**
 * Deterministic heuristic seed set grounded in known XKLĐ demand per market.
 * Always returns a non-empty list with demandScore in [0,100]. Used both as the
 * cold-start path (no AI) and the fallback when AI fails/returns nothing.
 */
export function heuristicTrends(market: Market): TrendSeed[] {
  const label = marketLabel(market);
  const base = MARKET_SEEDS[market] ?? MARKET_SEEDS.OTHER;
  // Defensive clone + clamp so callers cannot mutate the shared tables and the
  // [0,100] invariant always holds even if a table value is edited.
  return base.map((s) => ({
    keyword: s.keyword,
    topic: s.topic.replace('{label}', label),
    intent: s.intent,
    demandScore: clampDemandScore(s.demandScore),
    rationale: s.rationale.replace('{label}', label),
  }));
}

type SeedTable = Readonly<Record<Market, ReadonlyArray<TrendSeed>>>;

/**
 * Per-market demand tables. Topics/rationales use {label} so the Vietnamese
 * market name is injected deterministically. Keywords are intentionally the
 * real high-intent Vietnamese search phrases for XKLĐ.
 */
const MARKET_SEEDS: SeedTable = {
  JAPAN: [
    { keyword: 'lương đi xkld nhật bản', topic: 'Mức lương thực lãnh khi đi {label}', intent: 'salary', demandScore: 92, rationale: 'Lương là yếu tố tra cứu nhiều nhất cho thị trường {label}.' },
    { keyword: 'visa kỹ năng đặc định', topic: 'Điều kiện visa tokutei / kỹ năng đặc định', intent: 'visa', demandScore: 85, rationale: 'Diện tokutei đang mở rộng và được quan tâm cao.' },
    { keyword: 'chi phí đi nhật 2025', topic: 'Tổng chi phí xuất cảnh sang {label}', intent: 'cost', demandScore: 80, rationale: 'Người lao động so sánh chi phí trước khi quyết định.' },
    { keyword: 'đơn hàng thực tập sinh nhật', topic: 'Đơn hàng TTS đang tuyển cho {label}', intent: 'industries', demandScore: 78, rationale: 'Đơn hàng ngành cụ thể thu hút ứng viên phù hợp.' },
    { keyword: 'điều kiện đi nhật không cần tiếng', topic: 'Điều kiện tham gia chương trình {label}', intent: 'eligibility', demandScore: 70, rationale: 'Băn khoăn về điều kiện đầu vào rất phổ biến.' },
  ],
  KOREA: [
    { keyword: 'eps hàn quốc 2025', topic: 'Chương trình EPS đi {label}', intent: 'visa', demandScore: 90, rationale: 'EPS là cửa chính sang {label} và có kỳ thi định kỳ.' },
    { keyword: 'lương đi hàn quốc', topic: 'Mức lương lao động tại {label}', intent: 'salary', demandScore: 88, rationale: 'Lương cao là động lực hàng đầu cho {label}.' },
    { keyword: 'thi tiếng hàn eps topik', topic: 'Điều kiện và kỳ thi tiếng Hàn EPS-TOPIK', intent: 'eligibility', demandScore: 76, rationale: 'Đỗ EPS-TOPIK là điều kiện bắt buộc.' },
    { keyword: 'chi phí đi hàn quốc lao động', topic: 'Chi phí tham gia chương trình {label}', intent: 'cost', demandScore: 74, rationale: 'Chi phí và rủi ro cò mồi được tìm kiếm nhiều.' },
    { keyword: 'ngành tuyển lao động hàn quốc', topic: 'Ngành nghề đang tuyển tại {label}', intent: 'industries', demandScore: 68, rationale: 'Sản xuất, nông nghiệp, xây dựng có nhu cầu lớn.' },
  ],
  GERMANY: [
    { keyword: 'du học nghề đức', topic: 'Du học nghề / XKLĐ {label}', intent: 'visa', demandScore: 86, rationale: 'Du học nghề là kênh chính sang {label}.' },
    { keyword: 'lương điều dưỡng đức', topic: 'Lương ngành điều dưỡng tại {label}', intent: 'salary', demandScore: 84, rationale: 'Điều dưỡng là ngành thiếu hụt nhân lực ở {label}.' },
    { keyword: 'điều kiện đi đức làm việc', topic: 'Điều kiện tham gia chương trình {label}', intent: 'eligibility', demandScore: 72, rationale: 'Yêu cầu tiếng Đức B1/B2 cần được giải thích rõ.' },
    { keyword: 'chi phí du học nghề đức', topic: 'Chi phí sang {label}', intent: 'cost', demandScore: 70, rationale: 'Chi phí và học bổng được so sánh kỹ.' },
    { keyword: 'ngành nghề thiếu hụt tại đức', topic: 'Ngành nghề đang cần lao động ở {label}', intent: 'industries', demandScore: 66, rationale: 'Điều dưỡng, nhà hàng, cơ khí đang thiếu nhân lực.' },
  ],
  TAIWAN: [
    { keyword: 'lương đi đài loan', topic: 'Mức lương lao động tại {label}', intent: 'salary', demandScore: 87, rationale: 'Chi phí thấp, đi nhanh nên lương được quan tâm.' },
    { keyword: 'đơn hàng đài loan phí thấp', topic: 'Đơn hàng chi phí thấp đi {label}', intent: 'cost', demandScore: 82, rationale: '{label} hấp dẫn nhờ chi phí xuất cảnh thấp.' },
    { keyword: 'visa lao động đài loan', topic: 'Thủ tục visa lao động {label}', intent: 'visa', demandScore: 74, rationale: 'Quy trình visa nhanh là lợi thế của {label}.' },
    { keyword: 'điều kiện đi đài loan', topic: 'Điều kiện tham gia chương trình {label}', intent: 'eligibility', demandScore: 68, rationale: 'Độ tuổi và sức khỏe là điều kiện chính.' },
    { keyword: 'đơn hàng nhà máy điện tử đài loan', topic: 'Ngành nghề đang tuyển tại {label}', intent: 'industries', demandScore: 64, rationale: 'Điện tử, cơ khí, hộ lý có nhu cầu cao.' },
  ],
  AUSTRALIA: [
    { keyword: 'visa lao động nông nghiệp úc', topic: 'Visa lao động nông nghiệp {label}', intent: 'visa', demandScore: 83, rationale: 'Chương trình nông nghiệp {label} thu hút quan tâm lớn.' },
    { keyword: 'lương làm nông tại úc', topic: 'Mức lương lao động tại {label}', intent: 'salary', demandScore: 85, rationale: 'Lương theo giờ tại {label} cao hơn nhiều thị trường khác.' },
    { keyword: 'chi phí đi úc làm việc', topic: 'Chi phí tham gia chương trình {label}', intent: 'cost', demandScore: 72, rationale: 'Chi phí và visa là rào cản cần giải thích.' },
    { keyword: 'điều kiện tiếng anh đi úc', topic: 'Điều kiện tham gia chương trình {label}', intent: 'eligibility', demandScore: 66, rationale: 'Yêu cầu tiếng Anh khiến nhiều người tra cứu.' },
    { keyword: 'ngành tuyển lao động úc', topic: 'Ngành nghề đang tuyển tại {label}', intent: 'industries', demandScore: 60, rationale: 'Nông nghiệp, chế biến thực phẩm cần nhân lực.' },
  ],
  LITHUANIA: [
    { keyword: 'xkld litva', topic: 'Cơ hội việc làm tại {label}', intent: 'industries', demandScore: 70, rationale: '{label} là cửa ngõ lao động vào khối EU.' },
    { keyword: 'lương đi litva', topic: 'Mức lương lao động tại {label}', intent: 'salary', demandScore: 72, rationale: 'Lương EU hấp dẫn so với chi phí phải bỏ ra.' },
    { keyword: 'visa lao động litva eu', topic: 'Visa lao động {label} / khối Schengen', intent: 'visa', demandScore: 68, rationale: 'Visa Schengen mở khả năng di chuyển trong EU.' },
    { keyword: 'chi phí đi litva', topic: 'Chi phí tham gia chương trình {label}', intent: 'cost', demandScore: 62, rationale: 'Chi phí và tính minh bạch được người lao động cân nhắc.' },
    { keyword: 'điều kiện đi litva làm việc', topic: 'Điều kiện tham gia chương trình {label}', intent: 'eligibility', demandScore: 58, rationale: 'Điều kiện đầu vào còn mới nên cần tư vấn rõ.' },
  ],
  EUROPE: [
    { keyword: 'xkld châu âu 2025', topic: 'Cơ hội lao động tại {label}', intent: 'industries', demandScore: 75, rationale: 'Quan tâm tới thị trường {label} đang tăng mạnh.' },
    { keyword: 'lương lao động châu âu', topic: 'Mức lương lao động tại {label}', intent: 'salary', demandScore: 78, rationale: 'Mặt bằng lương {label} là điểm hấp dẫn chính.' },
    { keyword: 'visa schengen lao động', topic: 'Visa lao động khối {label} / Schengen', intent: 'visa', demandScore: 70, rationale: 'Quy trình visa Schengen được tra cứu nhiều.' },
    { keyword: 'chi phí đi châu âu làm việc', topic: 'Chi phí tham gia chương trình {label}', intent: 'cost', demandScore: 66, rationale: 'Chi phí cao hơn nên cần minh bạch lộ trình.' },
    { keyword: 'điều kiện đi châu âu', topic: 'Điều kiện tham gia chương trình {label}', intent: 'eligibility', demandScore: 60, rationale: 'Yêu cầu ngôn ngữ và tay nghề cần giải thích.' },
  ],
  DOMESTIC: [
    { keyword: 'việc làm lương cao trong nước', topic: 'Cơ hội việc làm {label}', intent: 'industries', demandScore: 64, rationale: 'Nhóm chưa sẵn sàng đi nước ngoài tìm việc {label}.' },
    { keyword: 'tuyển dụng khu công nghiệp', topic: 'Mức lương việc làm {label}', intent: 'salary', demandScore: 62, rationale: 'Lương khu công nghiệp là tiêu chí lựa chọn.' },
    { keyword: 'điều kiện ứng tuyển việc làm', topic: 'Điều kiện ứng tuyển {label}', intent: 'eligibility', demandScore: 55, rationale: 'Điều kiện và hồ sơ là thắc mắc thường gặp.' },
  ],
  OTHER: [
    { keyword: 'cơ hội xkld thị trường mới', topic: 'Cơ hội lao động ở {label}', intent: 'industries', demandScore: 50, rationale: 'Nhu cầu khám phá {label} dành cho người tìm hiểu chung.' },
    { keyword: 'lương đi xkld', topic: 'Mức lương khi đi lao động {label}', intent: 'salary', demandScore: 55, rationale: 'Lương luôn là tiêu chí so sánh hàng đầu.' },
    { keyword: 'chi phí đi xkld', topic: 'Chi phí tham gia chương trình {label}', intent: 'cost', demandScore: 52, rationale: 'Chi phí xuất cảnh là mối quan tâm chung.' },
  ],
};

export class TrendResearchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gemini?: ContentGenerator,
    /**
     * Optional brand-knowledge grounding seam. When present, the AI research
     * prompt is grounded in Thanh Giang facts; absent leaves the prompt
     * unchanged. Never affects the deterministic heuristic fallback.
     */
    private readonly brandKnowledge?: BrandKnowledgeProvider,
  ) {}

  /**
   * Research a market: AI when configured (tolerant parse), else/along-failure a
   * deterministic heuristic seed set. Never throws for missing AI. Persists each
   * seed as a TrendSignal (status DISCOVERED) and returns the created rows.
   */
  async research(market: string, opts: ResearchOptions = {}): Promise<ResearchResult> {
    if (!isMarket(market)) {
      throw new ValidationError('Unknown market', 'TREND_MARKET_INVALID');
    }

    const { seeds, aiGenerated } = await this.gatherSeeds(market);
    // Serialize provenance to a JSON-safe array for the Prisma Json column.
    const sources: Prisma.InputJsonValue = Array.isArray(opts.sources)
      ? (JSON.parse(JSON.stringify(opts.sources)) as Prisma.InputJsonValue)
      : [];

    const created: TrendSignal[] = [];
    for (const seed of seeds) {
      const signal = await this.prisma.trendSignal.create({
        data: {
          market,
          keyword: seed.keyword,
          topic: seed.topic,
          intent: seed.intent,
          demandScore: seed.demandScore,
          rationale: seed.rationale,
          sources,
          status: 'DISCOVERED',
        },
      });
      created.push(signal);
    }

    return { created, aiGenerated };
  }

  /** Resolve seeds from AI (if any) with a deterministic heuristic fallback. */
  private async gatherSeeds(market: Market): Promise<{ seeds: TrendSeed[]; aiGenerated: boolean }> {
    if (this.gemini) {
      try {
        // Optional brand grounding (never throws); prepended to the prompt.
        const grounding = this.brandKnowledge
          ? await this.brandKnowledge.groundingBlock({ market })
          : undefined;
        const text = await this.gemini.generateContent(buildResearchPrompt(market, grounding));
        const parsed = parseTrends(text);
        if (parsed.length > 0) {
          return { seeds: parsed, aiGenerated: true };
        }
      } catch {
        // Unconfigured / network / bad response: fall through to the heuristic.
      }
    }
    return { seeds: heuristicTrends(market), aiGenerated: false };
  }

  /** List signals, optionally filtered by market and/or status (newest first). */
  async list(market?: string, status?: string): Promise<TrendSignal[]> {
    const where: { market?: string; status?: TrendStatus } = {};
    if (market !== undefined && isMarket(market)) where.market = market;
    if (status !== undefined && isTrendStatus(status)) where.status = status;
    return this.prisma.trendSignal.findMany({
      where,
      orderBy: [{ demandScore: 'desc' }, { discoveredAt: 'desc' }],
    });
  }

  /**
   * Review a signal: move DISCOVERED/REVIEWED -> REVIEWED|ADOPTED|DISMISSED via a
   * guarded transition. 404 when missing; 400 for an invalid target status; 409
   * for an illegal transition (e.g. from a terminal status).
   */
  async review(id: string, status: string): Promise<TrendSignal> {
    if (!REVIEW_TARGETS.has(status)) {
      throw new ValidationError('Invalid review status', 'TREND_REVIEW_STATUS_INVALID');
    }
    const signal = await this.prisma.trendSignal.findUnique({ where: { id } });
    if (!signal) {
      throw new NotFoundError('Trend signal not found', 'TREND_NOT_FOUND');
    }
    const result = trendTransition(signal.status as TrendStatus, status as TrendStatus);
    if (!result.ok) {
      throw new ConflictError(
        `Cannot move trend from ${signal.status} to ${status}`,
        'TREND_TRANSITION_INVALID',
      );
    }
    return this.prisma.trendSignal.update({
      where: { id },
      data: { status: status as TrendStatus },
    });
  }

  /** ADOPTED signals for a market, highest demand first — the planner's input. */
  async adoptedTopics(market: string): Promise<TrendSignal[]> {
    const where: { status: TrendStatus; market?: string } = { status: 'ADOPTED' };
    if (isMarket(market)) where.market = market;
    return this.prisma.trendSignal.findMany({
      where,
      orderBy: [{ demandScore: 'desc' }, { discoveredAt: 'desc' }],
    });
  }
}

/** Narrow an unknown string to a TrendStatus. */
export function isTrendStatus(v: unknown): v is TrendStatus {
  return v === 'DISCOVERED' || v === 'REVIEWED' || v === 'ADOPTED' || v === 'DISMISSED';
}
