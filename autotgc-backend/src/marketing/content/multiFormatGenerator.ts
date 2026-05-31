/**
 * Multi_Format_Generator — AI multi-format content generation for the marketing
 * autopilot (Thanh Giang — Vietnamese labor-export / XKLĐ). It writes SEO
 * articles, Fanpage captions, short-video scripts, emails, care messages and
 * chatbot FAQ scripts in Vietnamese, biased per target market and optimized to
 * pull views / follows / leads.
 *
 * Design mirrors `content/generationService.ts` EXACTLY:
 *   - Same ctor seam: (prisma, gemini, aiContextReader). The caller passes a
 *     `new PrismaAiPromptContextReader(prisma)`.
 *   - VALIDATE FIRST: all request validation (400s) happens BEFORE any AI call,
 *     so a misconfigured request never reaches Gemini.
 *   - Cold-start safe AI_Prompt_Context load (try/catch → null); the performance
 *     segment is emitted iff the context is complete, and the draft is flagged
 *     `generatedWithoutFeedback` otherwise.
 *   - `buildFormatPrompt` is pure + exported: it emits prompt segments in a
 *     strict, fixed order with the format directive first, the objective in the
 *     middle, the performance segment iff the context is complete, and the
 *     output-contract instruction ALWAYS LAST.
 *   - UNLIKE the consultant fallback, generation NEVER fabricates content: a
 *     Gemini failure (502 AI_NOT_CONFIGURED, network, bad response) is rethrown
 *     and nothing is persisted.
 */
import type { ContentDraft, Prisma, PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../infra/errors';
import { isRecord, asString } from '../../platforms/narrow';
import { stripCodeFences } from '../../strategy/personaService';
import type { ContentGenerator } from '../../strategy/personaService';
import {
  isPerformanceContextComplete,
  parseGeneratedContent,
} from '../../content/generationService';
import type {
  AiPromptContextReader,
  Objective,
  PerformanceContext,
} from '../../content/generationService';
import { isMarket, marketLabel } from '../markets';
import type { Market } from '../markets';
import type { BrandKnowledgeProvider } from '../brandKnowledge';
import { FORMAT_META, isContentFormat } from './formats';
import type { ContentFormat } from './formats';

/** Allowed content objectives (mirror GenerationService). */
const OBJECTIVES: ReadonlySet<string> = new Set<Objective>(['Lead', 'View', 'Follow']);

/** Default tone applied when no persona/domain tone is available (cold start). */
const DEFAULT_TONE = 'thân thiện, đáng tin cậy';

/** Synthesized CTA for CTA-optional formats that return no CTA (UX ≥1 invariant). */
export const DEFAULT_CARE_CTA = 'Liên hệ Thanh Giang để được tư vấn';

/** Raw, boundary-level request (all fields optional; validate() narrows them). */
export interface MultiFormatRequest {
  format?: string;
  domainName?: string;
  personaIds?: string[];
  objective?: string;
  market?: string;
  topic?: string;
  keyword?: string;
  seoKeywords?: unknown[];
  planItemId?: string;
}

/** A fully validated request (the shape generate() actually works with). */
export interface ValidatedMultiFormatRequest {
  format: ContentFormat;
  domainName: string;
  personaIds: string[];
  objective: Objective;
  market?: Market;
  topic?: string;
  keyword?: string;
  seoKeywords: string[];
  planItemId?: string;
}

/** Resolved domain + persona facts + per-request hints used to build the prompt. */
export interface FormatPromptInputs {
  domainName: string;
  domainContext: string;
  personaSummaries: string[];
  toneOfVoice: string;
  objective: Objective;
  market?: Market;
  topic?: string;
  keyword?: string;
  seoKeywords?: string[];
}

/** Parsed model output, with SEO extras when present. */
export interface FormatContent {
  title: string;
  body: string;
  ctas: string[];
  metaDescription?: string;
  keywords: string[];
}

/** Result of a successful multi-format generation. */
export interface MultiFormatResult {
  draft: ContentDraft;
  format: ContentFormat;
  aiGenerated: true;
  generatedWithoutFeedback: boolean;
}

/** Format-specific expert role (Vietnamese), embedded in the directive segment. */
const FORMAT_ROLE: Record<ContentFormat, string> = {
  GENERIC: 'chuyên gia copywriting marketing nội dung',
  SEO_ARTICLE: 'chuyên gia viết bài chuẩn SEO cho lĩnh vực xuất khẩu lao động (XKLĐ)',
  FANPAGE_CAPTION: 'chuyên gia viết caption Fanpage thu hút tương tác',
  VIDEO_SCRIPT: 'biên kịch video ngắn (TikTok/Reels) cho ngành XKLĐ',
  EMAIL: 'chuyên gia viết email marketing chăm sóc khách hàng',
  CARE_MESSAGE: 'chuyên viên chăm sóc khách hàng qua Zalo/SMS',
  CHATBOT_FAQ: 'chuyên gia xây dựng kịch bản chatbot FAQ',
};

/** Pure: the JSON output contract per format (the LAST prompt segment). */
export function outputContract(format: ContentFormat): string {
  switch (format) {
    case 'SEO_ARTICLE':
      return (
        'Trả về JSON với các khóa: "title" (string), "metaDescription" (string), ' +
        '"body" (string Markdown có thẻ H2/H3), "ctas" (mảng tối thiểu 1 lời kêu gọi hành động), ' +
        '"keywords" (mảng từ khóa SEO). Bắt buộc tối thiểu 1 CTA.'
      );
    case 'FANPAGE_CAPTION':
      return (
        'Trả về JSON với các khóa: "title" (string), "body" (string tối đa 600 ký tự kèm hashtag), ' +
        '"ctas" (mảng tối thiểu 1 CTA). Bắt buộc tối thiểu 1 CTA.'
      );
    case 'VIDEO_SCRIPT':
      return (
        'Trả về JSON với các khóa: "title" (string), "body" (string gồm hook, các cảnh quay, ' +
        'voiceover và chữ hiển thị trên màn hình), "ctas" (mảng tối thiểu 1 CTA). Bắt buộc tối thiểu 1 CTA.'
      );
    case 'EMAIL':
      return (
        'Trả về JSON với các khóa: "title" (string — tiêu đề/subject), "body" (string thân email), ' +
        '"ctas" (mảng tối thiểu 1 CTA). Bắt buộc tối thiểu 1 CTA.'
      );
    case 'CARE_MESSAGE':
      return (
        'Trả về JSON với các khóa: "title" (string), "body" (string ngắn gọn, giọng Zalo/SMS), ' +
        '"ctas" (mảng, có thể rỗng).'
      );
    case 'CHATBOT_FAQ':
      return (
        'Trả về JSON với các khóa: "title" (string), "body" (string gồm các cặp Hỏi–Đáp), ' +
        '"ctas" (mảng, có thể rỗng).'
      );
    case 'GENERIC':
    default:
      return (
        'Trả về JSON với các khóa: "title" (string), "body" (string), ' +
        '"ctas" (mảng tối thiểu 1 CTA). Bắt buộc tối thiểu 1 CTA.'
      );
  }
}

/**
 * Pure format-specific prompt builder. Emits, in strict order:
 *   0. [CongTy]/[TriThuc]  (brand-knowledge grounding — FIRST, ONLY when supplied)
 *   1. [ExpertRole][Format:CODE]  (format directive)
 *   2. [DomainContext]
 *   3. [Persona]
 *   4. [Tone]
 *   5. [Objective]
 *   6. [Market]            (ONLY when a market is provided)
 *   7. [Keyword]           (ONLY when topic/keyword/seoKeywords supplied)
 *   8. [PerformanceContext](ONLY when ctx is complete)
 *   9. [OutputContract]    (JSON output instruction — ALWAYS LAST)
 *
 * `grounding` is passed IN (not fetched here) so the builder stays pure. When
 * provided it is prepended verbatim as the first segment, grounding the model in
 * Thanh Giang facts BEFORE the expert-role directive; the output contract stays
 * last. When omitted the prompt is byte-identical to the pre-grounding behavior.
 */
export function buildFormatPrompt(
  format: ContentFormat,
  inputs: FormatPromptInputs,
  ctx: PerformanceContext | null,
  grounding?: string,
): string {
  const meta = FORMAT_META[format];
  const segments: string[] = [];

  if (grounding && grounding.trim().length > 0) {
    segments.push(grounding.trim());
  }

  segments.push(
    `[ExpertRole][Format:${format}] Bạn là ${FORMAT_ROLE[format]} cho Thanh Giang (XKLĐ). ` +
      `Định dạng: ${meta.label} (${meta.lengthHint}).`,
  );
  segments.push(`[DomainContext] Lĩnh vực: ${inputs.domainName}. ${inputs.domainContext}`.trim());
  segments.push(`[Persona] Chân dung khách hàng mục tiêu: ${inputs.personaSummaries.join(' | ')}`);
  segments.push(`[Tone] Viết bằng tiếng Việt với giọng văn ${inputs.toneOfVoice}.`);
  segments.push(
    `[Objective] Mục tiêu nội dung: ${inputs.objective} (tối ưu để kéo view/follow/lead).`,
  );

  if (inputs.market) {
    segments.push(`[Market] Thị trường: ${marketLabel(inputs.market)} (mã: ${inputs.market}).`);
  }

  const keywordParts: string[] = [];
  if (inputs.topic && inputs.topic.trim().length > 0) keywordParts.push(`Chủ đề: ${inputs.topic.trim()}.`);
  if (inputs.keyword && inputs.keyword.trim().length > 0) {
    keywordParts.push(`Từ khóa chính: ${inputs.keyword.trim()}.`);
  }
  const seoKw = inputs.seoKeywords ?? [];
  if (seoKw.length > 0) keywordParts.push(`Từ khóa SEO cần phủ: ${seoKw.join(', ')}.`);
  if (keywordParts.length > 0) {
    segments.push(`[Keyword] ${keywordParts.join(' ')}`);
  }

  if (isPerformanceContextComplete(ctx)) {
    segments.push(
      `[PerformanceContext] Ưu tiên chủ đề ${JSON.stringify(ctx.topPerformingTopics)}; ` +
        `dùng mẫu CTA ${JSON.stringify(ctx.bestCtaPatterns)}; ` +
        `tránh ${JSON.stringify(ctx.avoidTopics)}; ` +
        `độ dài tối ưu ${JSON.stringify(ctx.optimalContentLength)}.`,
    );
  }

  segments.push(`[OutputContract] ${outputContract(format)}`);

  return segments.join('\n');
}

/**
 * Parse the model response for a given format. Reuses parseGeneratedContent for
 * CTA-required formats (enforces title + body + ≥1 CTA), additionally capturing
 * metaDescription + keywords for SEO_ARTICLE. For CTA-optional formats
 * (CARE_MESSAGE / CHATBOT_FAQ) it enforces title + body and synthesizes one
 * sensible default CTA when none is returned, keeping the DraftCta ≥1 invariant.
 * Throws ValidationError (GEN_*_MISSING / GEN_OUTPUT_INVALID) on unusable shapes.
 */
export function parseFormatContent(format: ContentFormat, text: string): FormatContent {
  const meta = FORMAT_META[format];

  if (meta.ctasRequired) {
    const base = parseGeneratedContent(text);
    const extras = extractFormatExtras(format, text);
    return { title: base.title, body: base.body, ctas: base.ctas, ...extras };
  }

  // CTA-optional formats: lenient parse + synthesized default CTA.
  const cleaned = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ValidationError('AI returned unparseable content', 'GEN_OUTPUT_INVALID');
  }
  if (!isRecord(parsed)) {
    throw new ValidationError('AI returned unparseable content', 'GEN_OUTPUT_INVALID');
  }

  const title = asString(parsed.title);
  const body = asString(parsed.body);
  if (!title) {
    throw new ValidationError('AI content is missing a title', 'GEN_TITLE_MISSING');
  }
  if (!body) {
    throw new ValidationError('AI content is missing a body', 'GEN_BODY_MISSING');
  }
  let ctas = extractCtas(parsed.ctas);
  if (ctas.length === 0) {
    ctas = [DEFAULT_CARE_CTA];
  }
  return { title, body, ctas, keywords: [] };
}

/** SEO_ARTICLE carries metaDescription + keywords; other formats carry none. */
function extractFormatExtras(
  format: ContentFormat,
  text: string,
): { metaDescription?: string; keywords: string[] } {
  if (format !== 'SEO_ARTICLE') return { keywords: [] };
  const cleaned = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { keywords: [] };
  }
  if (!isRecord(parsed)) return { keywords: [] };
  return {
    metaDescription: asString(parsed.metaDescription),
    keywords: extractStringArray(parsed.keywords),
  };
}

/** Mirror of generationService's (private) CTA extractor. */
function extractCtas(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((c) => asString(c)).filter((c): c is string => c !== undefined);
  }
  const single = asString(value);
  return single ? [single] : [];
}

/** Narrow an unknown to a trimmed, non-empty string array. */
function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0);
}

export class MultiFormatGenerator {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gemini: ContentGenerator,
    private readonly aiContextReader: AiPromptContextReader,
    /**
     * Optional brand-knowledge grounding seam. When present, generate() fetches
     * a Thanh Giang grounding block and prepends it to the prompt; when absent,
     * behavior is byte-identical to the pre-grounding generator (no regression).
     */
    private readonly brandKnowledge?: BrandKnowledgeProvider,
  ) {}

  /**
   * Validate a multi-format request (400 with NO AI call on any failure). Order:
   * format → domain → persona → objective → market. Returns the narrowed request.
   */
  validate(req: MultiFormatRequest): ValidatedMultiFormatRequest {
    if (!isContentFormat(req.format)) {
      throw new ValidationError('Invalid content format', 'GEN_FORMAT_INVALID');
    }
    const domainName = (req.domainName ?? '').trim();
    if (domainName.length === 0) {
      throw new ValidationError('Domain is required', 'GEN_DOMAIN_REQUIRED');
    }
    const personaIds = (req.personaIds ?? []).filter(
      (id) => typeof id === 'string' && id.trim().length > 0,
    );
    if (personaIds.length === 0) {
      throw new ValidationError('At least one persona is required', 'GEN_PERSONA_REQUIRED');
    }
    if (!req.objective || !OBJECTIVES.has(req.objective)) {
      throw new ValidationError('Objective must be one of Lead, View, Follow', 'GEN_OBJECTIVE_INVALID');
    }
    let market: Market | undefined;
    if (req.market !== undefined && req.market !== null) {
      if (!isMarket(req.market)) {
        throw new ValidationError('Unknown market', 'GEN_MARKET_INVALID');
      }
      market = req.market;
    }

    return {
      format: req.format,
      domainName,
      personaIds,
      objective: req.objective as Objective,
      market,
      topic: typeof req.topic === 'string' ? req.topic.trim() || undefined : undefined,
      keyword: typeof req.keyword === 'string' ? req.keyword.trim() || undefined : undefined,
      seoKeywords: extractStringArray(req.seoKeywords),
      planItemId: typeof req.planItemId === 'string' ? req.planItemId.trim() || undefined : undefined,
    };
  }

  /**
   * Generate format-specific content. Validation (400) precedes any AI call; the
   * AI_Prompt_Context load is cold-start safe; a Gemini failure (incl. 502
   * AI_NOT_CONFIGURED) is rethrown with nothing persisted. On success persists a
   * DRAFT ContentDraft (+ DraftCta rows) carrying format / market / language /
   * planItemId / seoKeywords and returns it.
   */
  async generate(req: MultiFormatRequest): Promise<MultiFormatResult> {
    const validated = this.validate(req);

    // Same lookups GenerationService.generate performs.
    const domain = await this.prisma.domainContext.findUnique({
      where: { domainName: validated.domainName },
    });
    if (!domain) {
      throw new NotFoundError('Domain not found', 'GEN_DOMAIN_NOT_FOUND');
    }
    const personas = await this.prisma.contentPersona.findMany({
      where: { id: { in: validated.personaIds }, domainId: domain.id },
    });
    if (personas.length === 0) {
      throw new NotFoundError('No matching personas found', 'GEN_PERSONA_NOT_FOUND');
    }

    // Cold-start safe: never throw if context is missing/empty.
    let ctx: PerformanceContext | null = null;
    try {
      ctx = await this.aiContextReader.get();
    } catch {
      ctx = null;
    }
    const complete = isPerformanceContextComplete(ctx);
    const generatedWithoutFeedback = !complete;

    const toneOfVoice =
      personas[0].recommendedTone?.trim() ||
      personas[0].toneOfVoice?.trim() ||
      domain.defaultToneOfVoice?.trim() ||
      DEFAULT_TONE;

    const inputs: FormatPromptInputs = {
      domainName: domain.domainName,
      domainContext: domain.contextDescription,
      personaSummaries: personas.map(
        (p) => `${p.personaName} (age ${p.age}; needs: ${p.targetNeeds}; pains: ${p.painPoints})`,
      ),
      toneOfVoice,
      objective: validated.objective,
      market: validated.market,
      topic: validated.topic,
      keyword: validated.keyword,
      seoKeywords: validated.seoKeywords,
    };

    // Brand-knowledge grounding (optional, non-breaking): fetched BEFORE the
    // prompt is built and passed in, so buildFormatPrompt stays pure. The
    // provider never throws; an empty/absent block leaves the prompt unchanged.
    let grounding: string | undefined;
    if (this.brandKnowledge) {
      grounding = await this.brandKnowledge.groundingBlock({
        market: validated.market,
        topic: validated.topic,
        keyword: validated.keyword,
        format: validated.format,
      });
    }

    const prompt = buildFormatPrompt(validated.format, inputs, complete ? ctx : null, grounding);

    // Generation never fabricates: rethrow Gemini failures, persist nothing.
    const text = await this.gemini.generateContent(prompt);
    const parsed = parseFormatContent(validated.format, text);

    // Persist SEO keywords from the model output when present, else the request's.
    const keywords = parsed.keywords.length > 0 ? parsed.keywords : validated.seoKeywords;
    const seoKeywords: Prisma.InputJsonValue = JSON.parse(
      JSON.stringify(keywords),
    ) as Prisma.InputJsonValue;

    const draft = await this.prisma.contentDraft.create({
      data: {
        domainId: domain.id,
        personaId: personas[0].id,
        objective: validated.objective,
        title: parsed.title,
        body: parsed.body,
        status: 'DRAFT',
        format: validated.format,
        market: validated.market ?? null,
        language: 'vi',
        planItemId: validated.planItemId ?? null,
        seoKeywords,
        generatedWithoutFeedback,
        ctas: { create: parsed.ctas.map((ctaText) => ({ ctaText })) },
      },
      include: { ctas: true },
    });

    return { draft, format: validated.format, aiGenerated: true, generatedWithoutFeedback };
  }
}
