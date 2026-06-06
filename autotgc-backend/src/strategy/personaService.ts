/**
 * Persona_Manager — Content Strategy persona CRUD, AI recommendation, and the
 * shared validation gate (Content Pipeline Req 1, 2, 3).
 *
 * The validation gate is pure and reused by create / update / confirmRecommendation:
 * it rejects with HTTP 400 (no persistence) when the domain name is blank, the
 * tone-of-voice is blank, or any of age / target needs / pain points is missing,
 * treating whitespace-only as blank. AI recommendations are returned WITHOUT
 * persisting; a Gemini failure surfaces the underlying AppError unchanged.
 */
import type { ContentPersona, PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../infra/errors';
import { isRecord, asString } from '../platforms/narrow';

/** Optional generation tuning passed per-call (all fields optional). */
export interface GenerateOptions {
  /** Upper bound on output tokens; caps worst-case generation time. */
  maxTokens?: number;
  /** Sampling temperature (provider default when omitted). */
  temperature?: number;
}

/** Text generator seam (GeminiClient satisfies this structurally). */
export interface ContentGenerator {
  generateContent(prompt: string, options?: GenerateOptions): Promise<string>;
}

/** Persona attributes that may be supplied or recommended. */
export interface PersonaAttributes {
  personaName?: string;
  age?: string;
  interests?: string;
  targetNeeds?: string;
  painPoints?: string;
  toneOfVoice?: string;
  recommendedTone?: string;
}

/** Input for creating/confirming a persona (carries its domain name). */
export interface PersonaInput extends PersonaAttributes {
  domainName?: string;
}

/** True when a value is undefined, not a string, or only whitespace. */
function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Pure validation gate (Req 1.1–1.4, 2.2, 3.3, 3.4). Throws ValidationError (400)
 * when any required attribute is blank. Returns nothing on success.
 */
export function validatePersona(input: PersonaInput): void {
  if (isBlank(input.domainName)) {
    throw new ValidationError('Domain name is required', 'PERSONA_DOMAIN_REQUIRED');
  }
  if (isBlank(input.toneOfVoice)) {
    throw new ValidationError('Tone of voice is required', 'PERSONA_TONE_REQUIRED');
  }
  if (isBlank(input.age)) {
    throw new ValidationError('Age is required', 'PERSONA_AGE_REQUIRED');
  }
  if (isBlank(input.targetNeeds)) {
    throw new ValidationError('Target needs are required', 'PERSONA_TARGET_NEEDS_REQUIRED');
  }
  if (isBlank(input.painPoints)) {
    throw new ValidationError('Pain points are required', 'PERSONA_PAIN_POINTS_REQUIRED');
  }
}

/** Filter for listing personas. */
export interface PersonaListFilter {
  /** Restrict to personas under a specific domain name. */
  domainName?: string;
}

/** A persona row enriched with its domain name for list/read views. */
export type PersonaWithDomain = ContentPersona & { domainName: string };

/** Paginated persona list result. */
export interface PersonaListResult {
  items: PersonaWithDomain[];
  total: number;
  page: number;
  limit: number;
}

export class PersonaService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gemini: ContentGenerator,
  ) {}

  /**
   * List personas (newest first), optionally filtered by domain name, with
   * pagination. Each row carries its `domainName` so the UI can group/display
   * without a second lookup. This is the read endpoint the Strategy page needs
   * to render previously-created personas (not just session-local ones).
   */
  async list(
    filter: PersonaListFilter = {},
    page = 1,
    limit = 50,
  ): Promise<PersonaListResult> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;

    const where = filter.domainName?.trim()
      ? { domain: { domainName: filter.domainName.trim() } }
      : {};

    const [rows, total] = await Promise.all([
      this.prisma.contentPersona.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: { domain: { select: { domainName: true } } },
      }),
      this.prisma.contentPersona.count({ where }),
    ]);

    const items: PersonaWithDomain[] = rows.map((r) => {
      const { domain, ...persona } = r as ContentPersona & { domain: { domainName: string } };
      return { ...(persona as ContentPersona), domainName: domain.domainName };
    });

    return { items, total, page: safePage, limit: safeLimit };
  }

  /** Read a single persona by id, enriched with its domain name (404 if absent). */
  async get(id: string): Promise<PersonaWithDomain> {
    const row = await this.prisma.contentPersona.findUnique({
      where: { id },
      include: { domain: { select: { domainName: true } } },
    });
    if (!row) {
      throw new NotFoundError('Persona not found', 'PERSONA_NOT_FOUND');
    }
    const { domain, ...persona } = row as ContentPersona & { domain: { domainName: string } };
    return { ...(persona as ContentPersona), domainName: domain.domainName };
  }

  /** Create and persist a persona under its (upserted) domain (Req 1.5). */
  async create(input: PersonaInput): Promise<ContentPersona> {
    validatePersona(input);
    const domainName = (input.domainName as string).trim();
    const domain = await this.prisma.domainContext.upsert({
      where: { domainName },
      create: { domainName },
      update: {},
    });
    return this.prisma.contentPersona.create({
      data: {
        domainId: domain.id,
        personaName: input.personaName?.trim() ?? domainName,
        age: (input.age as string).trim(),
        interests: input.interests?.trim() ?? '',
        targetNeeds: (input.targetNeeds as string).trim(),
        painPoints: (input.painPoints as string).trim(),
        toneOfVoice: (input.toneOfVoice as string).trim(),
        recommendedTone: input.recommendedTone?.trim() ?? null,
      },
    });
  }

  /**
   * Update an existing persona (Req 2.1–2.3): 404 if the persona is missing,
   * then re-apply the validation gate against the merged attributes.
   */
  async update(id: string, attrs: PersonaAttributes): Promise<ContentPersona> {
    const existing = await this.prisma.contentPersona.findUnique({
      where: { id },
      include: { domain: true },
    });
    if (!existing) {
      throw new NotFoundError('Persona not found', 'PERSONA_NOT_FOUND');
    }

    const merged: PersonaInput = {
      domainName: existing.domain.domainName,
      personaName: attrs.personaName ?? existing.personaName,
      age: attrs.age ?? existing.age,
      interests: attrs.interests ?? existing.interests,
      targetNeeds: attrs.targetNeeds ?? existing.targetNeeds,
      painPoints: attrs.painPoints ?? existing.painPoints,
      toneOfVoice: attrs.toneOfVoice ?? existing.toneOfVoice,
      recommendedTone: attrs.recommendedTone ?? existing.recommendedTone ?? undefined,
    };
    validatePersona(merged);

    return this.prisma.contentPersona.update({
      where: { id },
      data: {
        personaName: (merged.personaName as string).trim(),
        age: (merged.age as string).trim(),
        interests: merged.interests?.trim() ?? '',
        targetNeeds: (merged.targetNeeds as string).trim(),
        painPoints: (merged.painPoints as string).trim(),
        toneOfVoice: (merged.toneOfVoice as string).trim(),
        recommendedTone: merged.recommendedTone?.trim() ?? null,
      },
    });
  }

  /**
   * Ask Gemini for proposed persona attributes (Req 3.1, 3.2). Returns the
   * suggestion WITHOUT persisting anything. A Gemini failure surfaces the
   * underlying AppError (e.g. 502 AI_NOT_CONFIGURED) and leaves personas intact.
   */
  async recommend(domainName: string): Promise<PersonaAttributes> {
    const name = (domainName ?? '').trim();
    if (name.length === 0) {
      throw new ValidationError('Domain name is required', 'PERSONA_DOMAIN_REQUIRED');
    }
    const prompt = this.buildRecommendationPrompt(name);
    const text = await this.gemini.generateContent(prompt);
    return parseRecommendation(text);
  }

  /**
   * Persist a persona from accepted/edited recommendation attributes (Req 3.3),
   * re-applying the validation gate first. A reject is a no-op handled by callers.
   */
  async confirmRecommendation(domainName: string, attrs: PersonaAttributes): Promise<ContentPersona> {
    return this.create({ ...attrs, domainName });
  }

  private buildRecommendationPrompt(domainName: string): string {
    return [
      'You are an expert marketing strategist.',
      `Propose one target audience persona for the business domain: "${domainName}".`,
      'Respond ONLY with a JSON object using these keys: personaName, age, interests,',
      'targetNeeds, painPoints, toneOfVoice. Values must be concise strings.',
    ].join('\n');
  }
}

/** Parse a recommendation JSON object out of the model's text response. */
export function parseRecommendation(text: string): PersonaAttributes {
  const cleaned = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ValidationError('AI returned an unparseable persona suggestion', 'PERSONA_SUGGESTION_INVALID');
  }
  if (!isRecord(parsed)) {
    throw new ValidationError('AI returned an unparseable persona suggestion', 'PERSONA_SUGGESTION_INVALID');
  }
  return {
    personaName: asString(parsed.personaName),
    age: asString(parsed.age),
    interests: asString(parsed.interests),
    targetNeeds: asString(parsed.targetNeeds),
    painPoints: asString(parsed.painPoints),
    toneOfVoice: asString(parsed.toneOfVoice),
    recommendedTone: asString(parsed.toneOfVoice),
  };
}

/** Strip Markdown code fences (```json ... ```), returning the inner text. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutFirst = trimmed.replace(/^```[a-zA-Z]*\s*/, '');
  const lastFence = withoutFirst.lastIndexOf('```');
  return (lastFence >= 0 ? withoutFirst.slice(0, lastFence) : withoutFirst).trim();
}
