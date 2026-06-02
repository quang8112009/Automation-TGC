/**
 * Generation_Service — request validation, deterministic prompt assembly, and
 * AI content generation with cold-start fallback (Content Pipeline Req 6, 7, 8).
 *
 * `buildPrompt` is pure and exported for property testing: it emits prompt
 * segments in a strict, fixed order with the required-CTA instruction ALWAYS
 * last and the performance-context segment present iff the AI_Prompt_Context is
 * complete. Generation never fails for missing context (cold start): it falls
 * back to the Default_Context, omits the performance segment, and marks the
 * draft `generatedWithoutFeedback`.
 */
import type { ContentDraft, PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError } from '../infra/errors';
import { isRecord, asString } from '../platforms/narrow';
import type { ContentGenerator } from '../strategy/personaService';
import { stripCodeFences } from '../strategy/personaService';

export const GEMINI_MODEL = 'gemini-2.5-flash';

/** Allowed content objectives (Req 6.4). */
export type Objective = 'Lead' | 'View' | 'Follow';
const OBJECTIVES: ReadonlySet<string> = new Set<Objective>(['Lead', 'View', 'Follow']);

export interface GenerationRequest {
  domainName?: string;
  personaIds?: string[];
  objective?: string;
}

/** Performance context loaded from AI_Prompt_Context (analytics feedback loop). */
export interface PerformanceContext {
  topPerformingTopics: unknown;
  bestCtaPatterns: unknown;
  avoidTopics: unknown;
  optimalContentLength: unknown;
}

/** Reader seam over the AI_Prompt_Context table; empty/cold-start safe. */
export interface AiPromptContextReader {
  get(): Promise<PerformanceContext | null>;
}

/** Resolved domain + persona facts used to build the prompt. */
export interface PromptInputs {
  domainName: string;
  domainContext: string;
  personaSummaries: string[];
  toneOfVoice: string;
  objective: Objective;
}

/** Result of a successful generation. */
export interface GenerationResult {
  draft: ContentDraft;
  generatedWithoutFeedback: boolean;
}

/** Default tone applied when no persona/domain tone is available (cold start). */
const DEFAULT_TONE = 'friendly';

/**
 * Pure: a PerformanceContext is "complete" iff every performance field is
 * present and non-empty (Req 6.6, 7.3). Incomplete/missing -> omit the segment.
 */
export function isPerformanceContextComplete(ctx: PerformanceContext | null): ctx is PerformanceContext {
  if (ctx === null) return false;
  return (
    isNonEmpty(ctx.topPerformingTopics) &&
    isNonEmpty(ctx.bestCtaPatterns) &&
    isNonEmpty(ctx.avoidTopics) &&
    isNonEmpty(ctx.optimalContentLength)
  );
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * Pure prompt builder (Req 6.6, 7.3). Emits, in order:
 *   1. expertRole
 *   2. domainContext
 *   3. persona
 *   4. tone
 *   5. objective
 *   6. performanceContext  (ONLY if ctx is complete)
 *   7. requiredCtaInstruction  (ALWAYS last)
 */
export function buildPrompt(inputs: PromptInputs, ctx: PerformanceContext | null): string {
  const segments: string[] = [];

  segments.push('[ExpertRole] You are an expert content marketing copywriter.');
  segments.push(`[DomainContext] Domain: ${inputs.domainName}. ${inputs.domainContext}`.trim());
  segments.push(`[Persona] Target personas: ${inputs.personaSummaries.join(' | ')}`);
  segments.push(`[Tone] Write in a ${inputs.toneOfVoice} tone of voice.`);
  segments.push(`[Objective] The objective of this content is: ${inputs.objective}.`);

  if (isPerformanceContextComplete(ctx)) {
    segments.push(
      `[PerformanceContext] Favor topics ${JSON.stringify(ctx.topPerformingTopics)}; ` +
        `use CTA patterns ${JSON.stringify(ctx.bestCtaPatterns)}; ` +
        `avoid ${JSON.stringify(ctx.avoidTopics)}; ` +
        `target length ${JSON.stringify(ctx.optimalContentLength)}.`,
    );
  }

  segments.push(
    '[RequiredCTA] Respond as JSON with keys "title" (string), "body" (string), and ' +
      '"ctas" (array of at least one call-to-action string). At least one CTA is required.',
  );

  return segments.join('\n');
}

/**
 * Pure regeneration prompt builder for the Self-Correction loop (proposal 3.1).
 * Reuses the base prompt, then appends the PREVIOUS rejected draft and the
 * human's rejection reason with an explicit instruction to revise — so the
 * model rewrites the same brief addressing the feedback instead of starting
 * blind. The required-CTA/JSON instruction from `buildPrompt` stays last.
 */
export function buildRegenerationPrompt(
  inputs: PromptInputs,
  previous: { title: string; body: string; ctas: string[] },
  rejectionReason: string,
  ctx: PerformanceContext | null,
): string {
  const base = buildPrompt(inputs, ctx);
  const revision = [
    '[PreviousDraft] A previous draft was REJECTED by a human reviewer. Rewrite it.',
    `Previous title: ${previous.title}`,
    `Previous body: ${previous.body}`,
    `Previous CTAs: ${previous.ctas.join(' | ')}`,
    `[RejectionReason] The reviewer asked for these changes: ${rejectionReason}`,
    '[RevisionInstruction] Produce an improved version that directly addresses the ' +
      'rejection reason while keeping the same domain, persona, tone and objective. ' +
      'Respond in the SAME JSON shape ("title", "body", "ctas").',
  ].join('\n');
  return `${base}\n${revision}`;
}

export class GenerationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gemini: ContentGenerator,
    private readonly aiContextReader: AiPromptContextReader,
  ) {}

  /**
   * Validate a generation request (Req 6.1–6.4). Requires a domain name, at
   * least one persona id, and a valid objective; otherwise 400 (generates nothing).
   */
  validate(req: GenerationRequest): { domainName: string; personaIds: string[]; objective: Objective } {
    const domainName = (req.domainName ?? '').trim();
    if (domainName.length === 0) {
      throw new ValidationError('Domain is required', 'GEN_DOMAIN_REQUIRED');
    }
    const personaIds = (req.personaIds ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0);
    if (personaIds.length === 0) {
      throw new ValidationError('At least one persona is required', 'GEN_PERSONA_REQUIRED');
    }
    if (!req.objective || !OBJECTIVES.has(req.objective)) {
      throw new ValidationError('Objective must be one of Lead, View, Follow', 'GEN_OBJECTIVE_INVALID');
    }
    return { domainName, personaIds, objective: req.objective as Objective };
  }

  /**
   * Generate content (Req 6.5–6.10, 7.1–7.3, 8.1). Loads AI_Prompt_Context (may
   * be empty -> cold start: omit performance segment, mark generatedWithoutFeedback,
   * never fail for missing context). On Gemini success persist a DRAFT + DraftCta
   * rows; on Gemini failure surface the error and persist nothing.
   */
  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const { domainName, personaIds, objective } = this.validate(req);

    const domain = await this.prisma.domainContext.findUnique({ where: { domainName } });
    if (!domain) {
      throw new NotFoundError('Domain not found', 'GEN_DOMAIN_NOT_FOUND');
    }
    const personas = await this.prisma.contentPersona.findMany({
      where: { id: { in: personaIds }, domainId: domain.id },
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

    const inputs: PromptInputs = {
      domainName: domain.domainName,
      domainContext: domain.contextDescription,
      personaSummaries: personas.map(
        (p) => `${p.personaName} (age ${p.age}; needs: ${p.targetNeeds}; pains: ${p.painPoints})`,
      ),
      toneOfVoice,
      objective,
    };

    const prompt = buildPrompt(inputs, complete ? ctx : null);

    // A Gemini failure must persist nothing and surface the error (Req 6.10).
    const text = await this.gemini.generateContent(prompt);
    const parsed = parseGeneratedContent(text);

    const draft = await this.prisma.contentDraft.create({
      data: {
        domainId: domain.id,
        personaId: personas[0].id,
        objective,
        title: parsed.title,
        body: parsed.body,
        status: 'DRAFT',
        generatedWithoutFeedback,
        ctas: { create: parsed.ctas.map((ctaText) => ({ ctaText })) },
      },
      include: { ctas: true },
    });

    return { draft, generatedWithoutFeedback };
  }

  /**
   * Self-Correction loop (proposal 3.1): rewrite a REJECTED-then-returned draft
   * in place using the reviewer's rejection reason, instead of discarding it.
   *
   * The draft must currently be in DRAFT (the Review_Service returns rejected
   * drafts to DRAFT and stores `rejectionReason`). We rebuild the original
   * prompt context (domain + persona + analytics) and append the previous draft
   * + rejection reason via `buildRegenerationPrompt`, call Gemini, and overwrite
   * the draft's title/body/CTAs with the revision. A Gemini failure persists
   * nothing and surfaces the error (mirrors `generate`). The reviewer must
   * re-preview before approving (we reset `previewPresented`).
   */
  async regenerateFromRejection(draftId: string, reasonOverride?: string): Promise<GenerationResult> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: draftId },
      include: { ctas: true, domain: true, persona: true },
    });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }
    if (draft.status !== 'DRAFT') {
      throw new ValidationError(
        'Only a draft in DRAFT status can be regenerated',
        'REGEN_STATUS_INVALID',
      );
    }
    const reason = (reasonOverride ?? draft.rejectionReason ?? '').trim();
    if (reason.length === 0) {
      throw new ValidationError(
        'A rejection reason is required to regenerate a draft',
        'REGEN_REASON_REQUIRED',
      );
    }

    // Cold-start safe context load (never throws for missing context).
    let ctx: PerformanceContext | null = null;
    try {
      ctx = await this.aiContextReader.get();
    } catch {
      ctx = null;
    }
    const complete = isPerformanceContextComplete(ctx);
    const generatedWithoutFeedback = !complete;

    const persona = draft.persona;
    const toneOfVoice =
      persona.recommendedTone?.trim() ||
      persona.toneOfVoice?.trim() ||
      draft.domain.defaultToneOfVoice?.trim() ||
      DEFAULT_TONE;

    const inputs: PromptInputs = {
      domainName: draft.domain.domainName,
      domainContext: draft.domain.contextDescription,
      personaSummaries: [
        `${persona.personaName} (age ${persona.age}; needs: ${persona.targetNeeds}; pains: ${persona.painPoints})`,
      ],
      toneOfVoice,
      objective: (draft.objective as Objective) ?? 'Lead',
    };

    const prompt = buildRegenerationPrompt(
      inputs,
      {
        title: draft.title,
        body: draft.body,
        ctas: draft.ctas.map((c) => c.ctaText),
      },
      reason,
      complete ? ctx : null,
    );

    // A Gemini failure must persist nothing and surface the error.
    const text = await this.gemini.generateContent(prompt);
    const parsed = parseGeneratedContent(text);

    // Overwrite the draft in place: replace CTAs, refresh title/body, reset the
    // preview gate, keep status DRAFT, and clear the consumed rejection reason.
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.draftCta.deleteMany({ where: { draftId } });
      return tx.contentDraft.update({
        where: { id: draftId },
        data: {
          title: parsed.title,
          body: parsed.body,
          status: 'DRAFT',
          previewPresented: false,
          rejectionReason: null,
          generatedWithoutFeedback,
          ctas: { create: parsed.ctas.map((ctaText) => ({ ctaText })) },
        },
        include: { ctas: true },
      });
    });

    return { draft: updated, generatedWithoutFeedback };
  }
}

export interface GeneratedContent {
  title: string;
  body: string;
  ctas: string[];
}

/**
 * Parse the model's response into Title/Body/CTA, enforcing the ≥1-CTA invariant
 * (Req 6.8, 6.9, 8.1). Accepts JSON (optionally code-fenced). Throws 502-class
 * AppError via ValidationError when the shape is unusable.
 */
export function parseGeneratedContent(text: string): GeneratedContent {
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
  const ctas = extractCtas(parsed.ctas);

  if (!title) {
    throw new ValidationError('AI content is missing a title', 'GEN_TITLE_MISSING');
  }
  if (!body) {
    throw new ValidationError('AI content is missing a body', 'GEN_BODY_MISSING');
  }
  if (ctas.length === 0) {
    throw new ValidationError('AI content must include at least one CTA', 'GEN_CTA_MISSING');
  }
  return { title, body, ctas };
}

function extractCtas(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((c) => asString(c)).filter((c): c is string => c !== undefined);
  }
  const single = asString(value);
  return single ? [single] : [];
}

/**
 * Prisma-backed AiPromptContextReader. Reads the single AI_Prompt_Context row
 * (cold-start safe: returns null when absent or any performance field is empty).
 */
export class PrismaAiPromptContextReader implements AiPromptContextReader {
  constructor(private readonly prisma: PrismaClient) {}

  async get(): Promise<PerformanceContext | null> {
    const row = await this.prisma.aiPromptContext.findFirst({
      orderBy: { lastUpdatedFromAnalytics: 'desc' },
    });
    if (!row) return null;
    return {
      topPerformingTopics: row.topPerformingTopics,
      bestCtaPatterns: row.bestCtaPatterns,
      avoidTopics: row.avoidTopics,
      optimalContentLength: row.optimalContentLength,
    };
  }
}
