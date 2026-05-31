/**
 * Property-based tests for the content-pipeline spec.
 *
 * Each test is tagged `// Feature: content-pipeline, Property {n}: {exact design text}`
 * and maps 1:1 to a Correctness Property in
 * `.kiro/specs/content-pipeline/design.md` (canonical numbering, Properties 1–23).
 *
 * Determinism: Gemini, the Platform_Adapter, the Token_Manager, the Alert
 * Dispatcher and the media object store are mocked; the clock is injected; and
 * PostgreSQL/Redis are exercised through in-memory repository fakes — exactly as
 * the design's Testing Strategy prescribes for property tests.
 *
 * NOTE: this file does not edit any existing tests. `test/content.test.ts` uses
 * ad-hoc property numbers that do NOT match the design; this file uses the
 * design's canonical numbers, so some coverage is intentionally duplicated.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../src/auth/jwt';

import {
  contentTransition,
  CONTENT_TRANSITIONS,
} from '../src/content/stateMachine';
import type { ContentStatus } from '../src/content/stateMachine';

import {
  validatePersona,
  PersonaService,
} from '../src/strategy/personaService';
import type {
  ContentGenerator,
  PersonaInput,
  PersonaAttributes,
} from '../src/strategy/personaService';

import { CalendarService, colorFor } from '../src/content/calendarService';

import {
  buildPrompt,
  isPerformanceContextComplete,
  parseGeneratedContent,
  GenerationService,
} from '../src/content/generationService';
import type {
  AiPromptContextReader,
  PerformanceContext,
  PromptInputs,
  Objective,
} from '../src/content/generationService';

import { MediaService } from '../src/content/mediaService';
import { DraftService } from '../src/content/draftService';
import { ReviewService } from '../src/content/reviewService';
import {
  SchedulingService,
  evaluatePlatformGate,
  TIKTOK_MAX_DESCRIPTION,
} from '../src/content/schedulingService';
import {
  PublishingWorker,
  classifyError,
  MAX_RETRIES,
} from '../src/content/publishingWorker';
import type { TokenChecker } from '../src/content/publishingWorker';

import { AdapterRegistry } from '../src/platforms/registry';
import type {
  PlatformAdapter,
  PublishRequest,
  PublishResult,
  PlatformId,
  Capability,
  AnalyticsResult,
} from '../src/platforms/adapter';
import { InMemoryAlertDispatcher } from '../src/infra/alerts';
import { AppError } from '../src/infra/errors';

// ===========================================================================
// Shared test doubles
// ===========================================================================

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

const ALL_STATUSES: ContentStatus[] = [
  'DRAFT',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'REJECTED',
  'FAILED',
];

const OBJECTIVES: Objective[] = ['Lead', 'View', 'Follow'];

const NOW = new Date('2025-06-01T00:00:00.000Z');

/** Returns a 400 iff `fn` throws an AppError with status 400. */
function throwStatus(fn: () => unknown): number | 'ok' {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err instanceof AppError ? err.status : -1;
  }
}

async function throwStatusAsync(fn: () => Promise<unknown>): Promise<number | 'ok'> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err instanceof AppError ? err.status : -1;
  }
}

/** Captures the last prompt passed to the model and returns a canned response. */
class CapturingGemini implements ContentGenerator {
  lastPrompt = '';
  constructor(private readonly response: string) {}
  async generateContent(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return this.response;
  }
}

/** A Platform_Adapter test double that records publish() invocations. */
class FakeAdapter implements PlatformAdapter {
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['publish']);
  readonly publishCalls: PublishRequest[] = [];
  constructor(
    readonly platform: PlatformId,
    private readonly behavior: (req: PublishRequest) => Promise<PublishResult>,
  ) {}
  supports(c: Capability): boolean {
    return this.capabilities.has(c);
  }
  async publish(req: PublishRequest): Promise<PublishResult> {
    this.publishCalls.push(req);
    return this.behavior(req);
  }
  async collectAnalytics(): Promise<AnalyticsResult> {
    throw new Error('not supported in tests');
  }
}

/** Token_Manager doubles. */
const okToken: TokenChecker = { isValid: async () => true, refresh: async () => undefined };
const deadToken: TokenChecker = {
  isValid: async () => false,
  refresh: async () => {
    throw new Error('refresh failed');
  },
};

function registryWith(adapter: PlatformAdapter): AdapterRegistry {
  return new AdapterRegistry().register(adapter);
}

// ---- In-memory Prisma fakes -------------------------------------------------

/** Persona + domain store backing PersonaService (P1, P2, P3). */
function fakePersonaStore(): {
  prisma: PrismaClient;
  personaCount: () => number;
  personasForDomain: (domainName: string) => Array<Record<string, unknown>>;
} {
  const domains = new Map<string, { id: string; domainName: string; defaultToneOfVoice: string; contextDescription: string }>();
  const personas = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const findDomainByName = (name: string) => [...domains.values()].find((d) => d.domainName === name);
  const prisma = {
    domainContext: {
      upsert: async (args: { where: { domainName: string }; create: { domainName: string } }) => {
        let d = findDomainByName(args.where.domainName);
        if (!d) {
          d = { id: `dom-${++seq}`, domainName: args.create.domainName, defaultToneOfVoice: 'friendly', contextDescription: 'ctx' };
          domains.set(d.id, d);
        }
        return d;
      },
      findUnique: async (args: { where: { domainName: string } }) => findDomainByName(args.where.domainName) ?? null,
    },
    contentPersona: {
      create: async (args: { data: Record<string, unknown> }) => {
        const p = { id: `per-${++seq}`, ...args.data };
        personas.set(p.id as string, p);
        return p;
      },
      findUnique: async (args: { where: { id: string }; include?: { domain?: boolean } }) => {
        const p = personas.get(args.where.id);
        if (!p) return null;
        if (args.include?.domain) return { ...p, domain: domains.get(p.domainId as string) };
        return p;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = personas.get(args.where.id);
        const np = { ...p, ...args.data };
        personas.set(args.where.id, np);
        return np;
      },
      findMany: async (args?: { where?: { domainId?: string } }) =>
        [...personas.values()].filter((p) => (args?.where?.domainId ? p.domainId === args.where.domainId : true)),
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    personaCount: () => personas.size,
    personasForDomain: (domainName: string) => {
      const d = findDomainByName(domainName);
      if (!d) return [];
      return [...personas.values()].filter((p) => p.domainId === d.id);
    },
  };
}

/** Generation Prisma fake that records created drafts (P5, P7, P8). */
function fakeGenerationPrisma(): { prisma: PrismaClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    domainContext: {
      findUnique: async () => ({
        id: 'dom-1',
        domainName: 'Coffee Shop',
        contextDescription: 'Local artisan coffee.',
        defaultToneOfVoice: 'friendly',
      }),
    },
    contentPersona: {
      findMany: async () => [
        {
          id: 'per-1',
          personaName: 'Busy Professional',
          age: '25-40',
          interests: 'productivity',
          targetNeeds: 'quick caffeine',
          painPoints: 'no time',
          toneOfVoice: 'energetic',
          recommendedTone: null,
          domainId: 'dom-1',
        },
      ],
    },
    contentDraft: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'draft-1', ...args.data, ctas: [] };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, created };
}

/** Reschedule Prisma fake (P4). */
function fakeReschedulePrisma(post: { id: string; status: string; scheduledAt: Date } | null): {
  prisma: PrismaClient;
  updates: Array<{ id: string; scheduledAt: Date }>;
} {
  const updates: Array<{ id: string; scheduledAt: Date }> = [];
  const prisma = {
    scheduledPost: {
      findUnique: async () => post,
      update: async (args: { where: { id: string }; data: { scheduledAt: Date } }) => {
        updates.push({ id: args.where.id, scheduledAt: args.data.scheduledAt });
        return { id: args.where.id, scheduledAt: args.data.scheduledAt };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, updates };
}

/** Single-draft store backing DraftService.edit (P9). */
function fakeDraftEditStore(initial: { id: string; title: string; body: string; status: string; ctas: string[] }): {
  prisma: PrismaClient;
  getDraft: () => { id: string; title: string; body: string; status: string };
} {
  const draft = { id: initial.id, title: initial.title, body: initial.body, status: initial.status };
  let ctas = initial.ctas.map((t) => ({ draftId: initial.id, ctaText: t }));
  const draftModel = {
    findUnique: async (args: { where: { id: string }; include?: { ctas?: boolean } }) => {
      if (args.where.id !== draft.id) return null;
      return args.include?.ctas ? { ...draft, ctas: [...ctas] } : { ...draft };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(draft, args.data);
      return { ...draft };
    },
  };
  const ctaModel = {
    deleteMany: async () => {
      ctas = [];
    },
    createMany: async (args: { data: Array<{ draftId: string; ctaText: string }> }) => {
      ctas.push(...args.data);
    },
  };
  const prisma = {
    contentDraft: draftModel,
    draftCta: ctaModel,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ contentDraft: draftModel, draftCta: ctaModel }),
  } as unknown as PrismaClient;
  return { prisma, getDraft: () => ({ ...draft }) };
}

/** Single-draft store backing ReviewService (P10, P11). */
function fakeReviewStore(initial: { id: string; status: string; previewPresented: boolean }): {
  prisma: PrismaClient;
  getDraft: () => { id: string; status: string; previewPresented: boolean; rejectionReason: string | null };
} {
  const draft = {
    id: initial.id,
    status: initial.status,
    previewPresented: initial.previewPresented,
    rejectionReason: null as string | null,
  };
  const prisma = {
    contentDraft: {
      findUnique: async (args: { where: { id: string } }) => (args.where.id === draft.id ? { ...draft } : null),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(draft, args.data);
        return { ...draft };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, getDraft: () => ({ ...draft }) };
}

/** Scheduling Prisma fake (P13, P14): one draft + configurable media assets. */
function fakeSchedulePrisma(
  draft: { id: string; status: string; body: string; ctas: string[] },
  assets: Array<{ kind: string }>,
): { prisma: PrismaClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  let seq = 0;
  const prisma = {
    contentDraft: {
      findUnique: async (args: { where: { id: string }; include?: { ctas?: boolean } }) => {
        if (args.where.id !== draft.id) return null;
        return { id: draft.id, status: draft.status, body: draft.body, ctas: draft.ctas.map((ctaText) => ({ ctaText })) };
      },
    },
    mediaAsset: {
      findMany: async () => assets.map((a, i) => ({ id: `m-${i}`, ...a })),
    },
    scheduledPost: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `sp-${++seq}`, ...args.data };
        created.push(row);
        return row;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, created };
}

/** Scheduling Prisma fake for retryFailed (P22). */
function fakeRetryPrisma(
  post: { id: string; status: string; platform: string },
  draft: { id: string; body: string; ctas: string[] },
  assets: Array<{ kind: string }>,
): { prisma: PrismaClient; getPost: () => { id: string; status: string; scheduledAt?: Date } } {
  const stored: { id: string; status: string; platform: string; draftId: string; scheduledAt?: Date } = {
    ...post,
    draftId: draft.id,
  };
  const prisma = {
    scheduledPost: {
      findUnique: async (args: { where: { id: string } }) => (args.where.id === stored.id ? { ...stored } : null),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(stored, args.data);
        return { ...stored };
      },
    },
    contentDraft: {
      findUnique: async (args: { where: { id: string } }) => {
        if (args.where.id !== draft.id) return null;
        return { id: draft.id, body: draft.body, ctas: draft.ctas.map((ctaText) => ({ ctaText })) };
      },
    },
    mediaAsset: {
      findMany: async () => assets.map((a, i) => ({ id: `m-${i}`, ...a })),
    },
  } as unknown as PrismaClient;
  return { prisma, getPost: () => ({ ...stored }) };
}

/** Due-scan Prisma fake (P15): findMany applies the SCHEDULED + lte filter. */
function fakeScanPrisma(posts: Array<{ id: string; status: string; scheduledAt: Date }>): PrismaClient {
  return {
    scheduledPost: {
      findMany: async (args: { where: { status: string; scheduledAt: { lte: Date } } }) =>
        posts
          .filter((p) => p.status === args.where.status && p.scheduledAt.getTime() <= args.where.scheduledAt.lte.getTime())
          .map((p) => ({ ...p })),
    },
  } as unknown as PrismaClient;
}

/** Lock Prisma fake (P16): atomic compare-and-set updateMany. */
function fakeLockPrisma(initialStatus: string): { prisma: PrismaClient; getStatus: () => string } {
  const post = { id: 'sp-1', status: initialStatus };
  const prisma = {
    scheduledPost: {
      updateMany: async (args: { where: { id: string; status: string }; data: { status: string } }) => {
        // Synchronous check-and-set: JS does not interleave this body, so it is
        // atomic — exactly one of N concurrent callers can win the transition.
        if (post.id === args.where.id && post.status === args.where.status) {
          post.status = args.data.status;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, getStatus: () => post.status };
}

/** Worker Prisma fake (P17, P18, P19, P20, P21). */
function fakeWorkerPrisma(opts: {
  status?: string;
  platform?: string;
  idempotencyKey?: string;
  externalPostId?: string | null;
  postUrl?: string | null;
  retryCount?: number;
}): { prisma: PrismaClient; getPost: () => Record<string, unknown> } {
  const post: Record<string, unknown> = {
    id: 'sp-1',
    draftId: 'd-1',
    platform: opts.platform ?? 'facebook',
    status: opts.status ?? 'PUBLISHING',
    idempotencyKey: opts.idempotencyKey ?? 'idem-1',
    externalPostId: opts.externalPostId ?? null,
    postUrl: opts.postUrl ?? null,
    errorCode: null,
    failureReason: null,
    retryCount: opts.retryCount ?? 0,
  };
  const draft = { id: 'd-1', title: 'Title', body: 'Body', ctas: [{ ctaText: 'Buy' }], media: [] as unknown[] };
  const prisma = {
    scheduledPost: {
      findUnique: async (args: { where: { id: string } }) => (args.where.id === post.id ? { ...post } : null),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        for (const [k, v] of Object.entries(args.data)) {
          if (v && typeof v === 'object' && 'increment' in (v as Record<string, unknown>)) {
            post[k] = ((post[k] as number) ?? 0) + (v as { increment: number }).increment;
          } else {
            post[k] = v;
          }
        }
        return { ...post };
      },
      updateMany: async (args: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        if (post.id === args.where.id && post.status === args.where.status) {
          Object.assign(post, args.data);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    contentDraft: {
      findUnique: async (args: { where: { id: string }; include?: { ctas?: boolean; media?: boolean } }) => {
        if (args.where.id !== draft.id) return null;
        return {
          ...draft,
          ctas: args.include?.ctas ? draft.ctas : [],
          media: args.include?.media ? draft.media : [],
        };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, getPost: () => ({ ...post }) };
}

// ===========================================================================
// Generators
// ===========================================================================

/** A "blank" string per the gate: empty or whitespace-only. */
const blankArb = fc.constantFrom('', ' ', '   ', '\t', '\n', '  \t ');
/** A non-blank string. */
const presentArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0);

/** A persona input where each field is independently present or blank/missing. */
const personaInputArb: fc.Arbitrary<PersonaInput> = fc.record({
  domainName: fc.oneof(presentArb, blankArb),
  toneOfVoice: fc.oneof(presentArb, blankArb),
  age: fc.oneof(presentArb, blankArb),
  targetNeeds: fc.oneof(presentArb, blankArb),
  painPoints: fc.oneof(presentArb, blankArb),
  personaName: fc.oneof(presentArb, blankArb),
  interests: fc.oneof(presentArb, fc.constant('')),
});

/** True iff `s` is a non-blank string (mirrors the gate's `!isBlank`). */
function nonBlank(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

function personaShouldPass(input: PersonaInput): boolean {
  return (
    nonBlank(input.domainName) &&
    nonBlank(input.toneOfVoice) &&
    nonBlank(input.age) &&
    nonBlank(input.targetNeeds) &&
    nonBlank(input.painPoints)
  );
}

const objectiveArb = fc.constantFrom(...OBJECTIVES);

const promptInputsArb: fc.Arbitrary<PromptInputs> = fc.record({
  domainName: fc.string({ minLength: 1, maxLength: 20 }),
  domainContext: fc.string({ maxLength: 30 }),
  personaSummaries: fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 1, maxLength: 3 }),
  toneOfVoice: fc.string({ minLength: 1, maxLength: 15 }),
  objective: objectiveArb,
});

const completeCtxArb: fc.Arbitrary<PerformanceContext> = fc.record({
  topPerformingTopics: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
  bestCtaPatterns: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
  avoidTopics: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
  optimalContentLength: fc.record({ min: fc.integer(), max: fc.integer() }),
});

/** An incomplete cold-start context: null or with >=1 empty performance field. */
const incompleteCtxArb: fc.Arbitrary<PerformanceContext | null> = fc.oneof(
  fc.constant(null),
  fc.record({
    topPerformingTopics: fc.constantFrom([] as unknown, '', null),
    bestCtaPatterns: fc.constantFrom([] as unknown, '', null),
    avoidTopics: fc.constantFrom([] as unknown, '', null),
    optimalContentLength: fc.constantFrom([] as unknown, '', null),
  }) as unknown as fc.Arbitrary<PerformanceContext>,
);

const CANNED_CONTENT = JSON.stringify({
  title: 'A Title',
  body: 'A body of content.',
  ctas: ['Buy now', 'Learn more'],
});

// ===========================================================================
// Property 1 — Persona validation gate
// ===========================================================================

describe('Property 1: Persona validation gate', () => {
  // Feature: content-pipeline, Property 1: For any persona create or edit submission, the Persona_Manager accepts it if and only if the domain name is non-blank, the tone-of-voice is non-blank, and all three of age, target needs, and pain points are present (treating whitespace-only as blank); otherwise it rejects the submission with HTTP 400 and persists no change to any Content_Persona.
  it('validatePersona accepts iff all required fields are non-blank', () => {
    fc.assert(
      fc.property(personaInputArb, (input) => {
        const result = throwStatus(() => validatePersona(input));
        if (personaShouldPass(input)) {
          expect(result).toBe('ok');
        } else {
          expect(result).toBe(400);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: content-pipeline, Property 1: For any persona create or edit submission, the Persona_Manager accepts it if and only if the domain name is non-blank, the tone-of-voice is non-blank, and all three of age, target needs, and pain points are present (treating whitespace-only as blank); otherwise it rejects the submission with HTTP 400 and persists no change to any Content_Persona.
  it('PersonaService.create rejects invalid input with 400 and persists nothing', async () => {
    await fc.assert(
      fc.asyncProperty(personaInputArb, async (input) => {
        const { prisma, personaCount } = fakePersonaStore();
        const service = new PersonaService(prisma, new CapturingGemini('{}'));
        const before = personaCount();
        const result = await throwStatusAsync(() => service.create(input));
        if (personaShouldPass(input)) {
          expect(result).toBe('ok');
          expect(personaCount()).toBe(before + 1);
        } else {
          expect(result).toBe(400);
          expect(personaCount()).toBe(before); // no persistence on rejection
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 2 — Persona persistence round-trip
// ===========================================================================

describe('Property 2: Persona persistence round-trip', () => {
  const validPersonaArb = fc.record({
    domainName: presentArb,
    toneOfVoice: presentArb,
    age: presentArb,
    targetNeeds: presentArb,
    painPoints: presentArb,
    personaName: presentArb,
    interests: presentArb,
  });

  // Feature: content-pipeline, Property 2: For any persona that passes the validation gate, creating it (or applying a valid edit) and then reading it back by its domain yields the same persona attributes (name, age, interests, target needs, pain points, tone-of-voice) associated with that domain.
  it('a created persona is read back with the same attributes under its domain', async () => {
    await fc.assert(
      fc.asyncProperty(validPersonaArb, async (input) => {
        const { prisma, personasForDomain } = fakePersonaStore();
        const service = new PersonaService(prisma, new CapturingGemini('{}'));
        const created = await service.create(input);

        const stored = personasForDomain((input.domainName as string).trim());
        expect(stored).toHaveLength(1);
        const p = stored[0];
        expect(p.id).toBe(created.id);
        expect(p.personaName).toBe(input.personaName.trim());
        expect(p.age).toBe(input.age.trim());
        expect(p.interests).toBe(input.interests.trim());
        expect(p.targetNeeds).toBe(input.targetNeeds.trim());
        expect(p.painPoints).toBe(input.painPoints.trim());
        expect(p.toneOfVoice).toBe(input.toneOfVoice.trim());
      }),
      { numRuns: 150 },
    );
  });

  // Feature: content-pipeline, Property 2: For any persona that passes the validation gate, creating it (or applying a valid edit) and then reading it back by its domain yields the same persona attributes (name, age, interests, target needs, pain points, tone-of-voice) associated with that domain.
  it('a valid edit is read back with the updated attributes', async () => {
    await fc.assert(
      fc.asyncProperty(validPersonaArb, validPersonaArb, async (initial, edit) => {
        const { prisma, personasForDomain } = fakePersonaStore();
        const service = new PersonaService(prisma, new CapturingGemini('{}'));
        const created = await service.create(initial);

        // Edit keeps the same domain (update() ignores domain changes).
        await service.update(created.id, {
          personaName: edit.personaName,
          age: edit.age,
          interests: edit.interests,
          targetNeeds: edit.targetNeeds,
          painPoints: edit.painPoints,
          toneOfVoice: edit.toneOfVoice,
        });

        const stored = personasForDomain((initial.domainName as string).trim());
        expect(stored).toHaveLength(1);
        const p = stored[0];
        expect(p.age).toBe(edit.age.trim());
        expect(p.targetNeeds).toBe(edit.targetNeeds.trim());
        expect(p.painPoints).toBe(edit.painPoints.trim());
        expect(p.toneOfVoice).toBe(edit.toneOfVoice.trim());
      }),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Property 3 — AI recommendation never persists by itself
// ===========================================================================

describe('Property 3: AI recommendation never persists by itself', () => {
  const recAttrsArb: fc.Arbitrary<PersonaAttributes> = fc.record({
    personaName: presentArb,
    age: presentArb,
    interests: presentArb,
    targetNeeds: presentArb,
    painPoints: presentArb,
    toneOfVoice: presentArb,
  });

  // Feature: content-pipeline, Property 3: For any set of persona attributes proposed by Gemini, requesting a recommendation returns those attributes to the caller and leaves the set of stored Content_Personas unchanged; a Content_Persona is created only by an explicit confirmation, which re-applies the validation gate of Property 1.
  it('recommend() returns the proposed attributes and persists nothing; confirm persists and re-applies the gate', async () => {
    await fc.assert(
      fc.asyncProperty(presentArb, recAttrsArb, async (domainName, attrs) => {
        const { prisma, personaCount } = fakePersonaStore();
        const gemini = new CapturingGemini(JSON.stringify(attrs));
        const service = new PersonaService(prisma, gemini);

        const before = personaCount();
        const proposed = await service.recommend(domainName);

        // Returned attributes match what Gemini proposed.
        expect(proposed.personaName).toBe(attrs.personaName);
        expect(proposed.age).toBe(attrs.age);
        expect(proposed.targetNeeds).toBe(attrs.targetNeeds);
        expect(proposed.painPoints).toBe(attrs.painPoints);
        expect(proposed.toneOfVoice).toBe(attrs.toneOfVoice);
        // Recommendation alone persists nothing.
        expect(personaCount()).toBe(before);

        // Explicit confirmation persists exactly one persona (gate passes here).
        await service.confirmRecommendation(domainName, proposed);
        expect(personaCount()).toBe(before + 1);
      }),
      { numRuns: 150 },
    );
  });

  // Feature: content-pipeline, Property 3: For any set of persona attributes proposed by Gemini, requesting a recommendation returns those attributes to the caller and leaves the set of stored Content_Personas unchanged; a Content_Persona is created only by an explicit confirmation, which re-applies the validation gate of Property 1.
  it('confirmRecommendation re-applies the validation gate (blank field -> 400, no persistence)', async () => {
    await fc.assert(
      fc.asyncProperty(presentArb, recAttrsArb, blankArb, async (domainName, attrs, blank) => {
        const { prisma, personaCount } = fakePersonaStore();
        const service = new PersonaService(prisma, new CapturingGemini('{}'));
        const before = personaCount();
        // Corrupt one required attribute so the gate must reject on confirm.
        const bad = { ...attrs, toneOfVoice: blank };
        const result = await throwStatusAsync(() => service.confirmRecommendation(domainName, bad));
        expect(result).toBe(400);
        expect(personaCount()).toBe(before);
      }),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Property 4 — Reschedule validity (drag-and-drop)
// ===========================================================================

describe('Property 4: Reschedule validity (drag-and-drop)', () => {
  // Feature: content-pipeline, Property 4: For any Scheduled_Post and any requested new time, the Calendar_Manager updates the scheduled publish time if and only if the post's current status is SCHEDULED and the new time is strictly later than the current time; in every other case it rejects the change and leaves the scheduled publish time unchanged.
  it('reschedule succeeds iff status is SCHEDULED and the new time is strictly future', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STATUSES),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        async (status, offsetMs) => {
          const original = new Date(NOW.getTime() + 86_400_000);
          const { prisma, updates } = fakeReschedulePrisma({ id: 'sp-1', status, scheduledAt: original });
          const service = new CalendarService(prisma, fixedClock(NOW));
          const newTime = new Date(NOW.getTime() + offsetMs);

          const shouldSucceed = status === 'SCHEDULED' && newTime.getTime() > NOW.getTime();
          let ok = false;
          try {
            await service.reschedule('sp-1', newTime);
            ok = true;
          } catch {
            ok = false;
          }

          expect(ok).toBe(shouldSucceed);
          if (shouldSucceed) {
            expect(updates).toHaveLength(1);
            expect(updates[0].scheduledAt.getTime()).toBe(newTime.getTime());
          } else {
            expect(updates).toHaveLength(0); // time unchanged
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 5 — Generation request validation
// ===========================================================================

describe('Property 5: Generation request validation', () => {
  const reqArb = fc.record({
    domainName: fc.oneof(presentArb, blankArb, fc.constant(undefined)),
    personaIds: fc.oneof(
      fc.array(fc.oneof(presentArb, blankArb), { maxLength: 3 }),
      fc.constant(undefined),
    ),
    objective: fc.oneof(fc.constantFrom(...OBJECTIVES) as fc.Arbitrary<string>, presentArb, fc.constant(undefined)),
  });

  // Feature: content-pipeline, Property 5: For any generation request, the Generation_Service proceeds to generate if and only if a domain is provided, at least one Content_Persona is selected, and the objective is one of {Lead, View, Follow}; otherwise it rejects with HTTP 400 and produces no Content_Draft.
  it('validate accepts iff domain present, >=1 persona, and objective in {Lead,View,Follow}', () => {
    fc.assert(
      fc.property(reqArb, (req) => {
        const domainOk = nonBlank(req.domainName);
        const personaOk = Array.isArray(req.personaIds) && req.personaIds.some((id) => nonBlank(id));
        const objectiveOk = typeof req.objective === 'string' && (OBJECTIVES as string[]).includes(req.objective);
        const expectedOk = domainOk && personaOk && objectiveOk;

        const { prisma } = fakeGenerationPrisma();
        const service = new GenerationService(prisma, new CapturingGemini(CANNED_CONTENT), { get: async () => null });
        const result = throwStatus(() => service.validate(req));
        if (expectedOk) {
          expect(result).toBe('ok');
        } else {
          expect(result).toBe(400);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: content-pipeline, Property 5: For any generation request, the Generation_Service proceeds to generate if and only if a domain is provided, at least one Content_Persona is selected, and the objective is one of {Lead, View, Follow}; otherwise it rejects with HTTP 400 and produces no Content_Draft.
  it('an invalid request produces no Content_Draft', async () => {
    await fc.assert(
      fc.asyncProperty(reqArb, async (req) => {
        const domainOk = nonBlank(req.domainName);
        const personaOk = Array.isArray(req.personaIds) && req.personaIds.some((id) => nonBlank(id));
        const objectiveOk = typeof req.objective === 'string' && (OBJECTIVES as string[]).includes(req.objective);
        fc.pre(!(domainOk && personaOk && objectiveOk)); // focus on the invalid branch

        const { prisma, created } = fakeGenerationPrisma();
        const service = new GenerationService(prisma, new CapturingGemini(CANNED_CONTENT), { get: async () => null });
        const result = await throwStatusAsync(() => service.generate(req));
        expect(result).toBe(400);
        expect(created).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 6 — Gemini prompt segment ordering
// ===========================================================================

describe('Property 6: Gemini prompt segment ordering', () => {
  // Feature: content-pipeline, Property 6: For any valid generation request and any AI_Prompt_Context, the prompt built by buildPrompt emits its segments in the strict order expert role → domain context → persona → tone-of-voice → objective → (optional performance context) → required-CTA instruction, with the required-CTA instruction always last; the performance-context segment is present if and only if the AI_Prompt_Context is complete.
  it('buildPrompt emits segments in fixed order with required-CTA last and perf segment iff complete', () => {
    fc.assert(
      fc.property(
        promptInputsArb,
        fc.oneof(completeCtxArb, incompleteCtxArb),
        (inputs, ctx) => {
          const prompt = buildPrompt(inputs, ctx);
          const order = ['[ExpertRole]', '[DomainContext]', '[Persona]', '[Tone]', '[Objective]'];
          const positions = order.map((tag) => prompt.indexOf(tag));
          for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
          for (let i = 1; i < positions.length; i++) {
            expect(positions[i]).toBeGreaterThan(positions[i - 1]);
          }
          const ctaPos = prompt.indexOf('[RequiredCTA]');
          const perfPos = prompt.indexOf('[PerformanceContext]');
          // Required-CTA is always present and strictly last.
          expect(ctaPos).toBeGreaterThan(positions[positions.length - 1]);
          if (isPerformanceContextComplete(ctx)) {
            expect(perfPos).toBeGreaterThan(positions[positions.length - 1]);
            expect(ctaPos).toBeGreaterThan(perfPos);
          } else {
            expect(perfPos).toBe(-1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 7 — Generation output shape
// ===========================================================================

describe('Property 7: Generation output shape', () => {
  // Feature: content-pipeline, Property 7: For any successful Gemini response, the persisted Content_Draft contains a non-empty Title, a non-empty Body, and at least one CTA, and its initial Content_Status is DRAFT.
  it('a successful generation persists a DRAFT with non-empty title/body and >=1 CTA', async () => {
    const contentArb = fc.record({
      title: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
      body: fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0),
      ctas: fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0), {
        minLength: 1,
        maxLength: 4,
      }),
    });
    await fc.assert(
      fc.asyncProperty(contentArb, fc.oneof(completeCtxArb, incompleteCtxArb), async (content, ctx) => {
        const { prisma, created } = fakeGenerationPrisma();
        const gemini = new CapturingGemini(JSON.stringify(content));
        const service = new GenerationService(prisma, gemini, { get: async () => ctx });
        const { draft } = await service.generate({
          domainName: 'Coffee Shop',
          personaIds: ['per-1'],
          objective: 'Lead',
        });
        expect(created).toHaveLength(1);
        const data = created[0] as {
          title: string;
          body: string;
          status: string;
          ctas: { create: unknown[] };
        };
        expect(data.title.length).toBeGreaterThan(0);
        expect(data.body.length).toBeGreaterThan(0);
        expect(data.status).toBe('DRAFT');
        expect(data.ctas.create.length).toBeGreaterThanOrEqual(1);
        // The returned draft echoes the DRAFT status.
        expect((draft as { status: string }).status).toBe('DRAFT');
      }),
      { numRuns: 100 },
    );
  });

  // Feature: content-pipeline, Property 7: For any successful Gemini response, the persisted Content_Draft contains a non-empty Title, a non-empty Body, and at least one CTA, and its initial Content_Status is DRAFT.
  it('parseGeneratedContent always yields a non-empty title, body, and >=1 CTA', () => {
    const contentArb = fc.record({
      title: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
      body: fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0),
      ctas: fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0), {
        minLength: 1,
        maxLength: 4,
      }),
    });
    fc.assert(
      fc.property(contentArb, (content) => {
        const parsed = parseGeneratedContent(JSON.stringify(content));
        expect(parsed.title.length).toBeGreaterThan(0);
        expect(parsed.body.length).toBeGreaterThan(0);
        expect(parsed.ctas.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 8 — Cold-start generation fallback
// ===========================================================================

describe('Property 8: Cold-start generation fallback', () => {
  // Feature: content-pipeline, Property 8: For any AI_Prompt_Context that is empty or missing one or more performance fields, generation completes successfully using the Default_Context (selected persona + domain context + default tone), omits the performance-context segment, still yields at least one CTA, never fails because the context is unavailable, and marks the resulting Content_Draft generated_without_feedback; when the context is complete the draft is not so marked.
  it('cold-start omits the performance segment, marks generated_without_feedback, keeps >=1 CTA', async () => {
    await fc.assert(
      fc.asyncProperty(incompleteCtxArb, async (ctx) => {
        const { prisma, created } = fakeGenerationPrisma();
        const gemini = new CapturingGemini(CANNED_CONTENT);
        const service = new GenerationService(prisma, gemini, { get: async () => ctx });

        const result = await service.generate({
          domainName: 'Coffee Shop',
          personaIds: ['per-1'],
          objective: 'Lead',
        });

        expect(result.generatedWithoutFeedback).toBe(true);
        expect(gemini.lastPrompt.indexOf('[PerformanceContext]')).toBe(-1);
        const data = created[0] as { generatedWithoutFeedback: boolean; ctas: { create: unknown[] } };
        expect(data.generatedWithoutFeedback).toBe(true);
        expect(data.ctas.create.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: content-pipeline, Property 8: For any AI_Prompt_Context that is empty or missing one or more performance fields, generation completes successfully using the Default_Context (selected persona + domain context + default tone), omits the performance-context segment, still yields at least one CTA, never fails because the context is unavailable, and marks the resulting Content_Draft generated_without_feedback; when the context is complete the draft is not so marked.
  it('a complete performance context clears the flag and includes the segment', async () => {
    await fc.assert(
      fc.asyncProperty(completeCtxArb, async (ctx) => {
        const { prisma, created } = fakeGenerationPrisma();
        const gemini = new CapturingGemini(CANNED_CONTENT);
        const service = new GenerationService(prisma, gemini, { get: async () => ctx });

        const result = await service.generate({
          domainName: 'Coffee Shop',
          personaIds: ['per-1'],
          objective: 'View',
        });

        expect(result.generatedWithoutFeedback).toBe(false);
        expect(gemini.lastPrompt.indexOf('[PerformanceContext]')).toBeGreaterThanOrEqual(0);
        const data = created[0] as { generatedWithoutFeedback: boolean };
        expect(data.generatedWithoutFeedback).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 9 — Draft edit guard
// ===========================================================================

describe('Property 9: Draft edit guard', () => {
  // Feature: content-pipeline, Property 9: For any Content_Draft and any edit to its Title, Body, or CTA, the edit is persisted if the draft's status is DRAFT and is otherwise rejected with HTTP 409 leaving the draft unchanged.
  it('edits persist iff status is DRAFT, otherwise 409 with no change', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STATUSES),
        fc.record({ title: presentArb, body: presentArb }),
        async (status, edit) => {
          const { prisma, getDraft } = fakeDraftEditStore({
            id: 'd-1',
            title: 'orig-title',
            body: 'orig-body',
            status,
            ctas: ['orig-cta'],
          });
          const service = new DraftService(prisma);
          const result = await throwStatusAsync(() => service.edit('d-1', edit));

          if (status === 'DRAFT') {
            expect(result).toBe('ok');
            expect(getDraft().title).toBe(edit.title);
            expect(getDraft().body).toBe(edit.body);
          } else {
            expect(result).toBe(409);
            // Unchanged.
            expect(getDraft().title).toBe('orig-title');
            expect(getDraft().body).toBe('orig-body');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 10 — Review actions gated by preview and DRAFT status
// ===========================================================================

describe('Property 10: Review actions gated by preview and DRAFT status', () => {
  // Feature: content-pipeline, Property 10: For any Content_Draft, an approve or reject action changes the Content_Status only if a preview has been presented for that draft and the draft's status is DRAFT (a previewed DRAFT approve yields APPROVED); if no preview was presented the action is rejected with no status change, and if the status is not DRAFT the action is rejected with HTTP 409 with no status change.
  it('approve changes status only when previewed AND DRAFT (-> APPROVED), else no change', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ALL_STATUSES), fc.boolean(), async (status, previewed) => {
        const { prisma, getDraft } = fakeReviewStore({ id: 'd-1', status, previewPresented: previewed });
        const service = new ReviewService(prisma);
        const result = await throwStatusAsync(() => service.approve('d-1'));

        const shouldApprove = previewed && status === 'DRAFT';
        if (shouldApprove) {
          expect(result).toBe('ok');
          expect(getDraft().status).toBe('APPROVED');
        } else {
          expect(result).toBe(409);
          expect(getDraft().status).toBe(status); // no status change
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: content-pipeline, Property 10: For any Content_Draft, an approve or reject action changes the Content_Status only if a preview has been presented for that draft and the draft's status is DRAFT (a previewed DRAFT approve yields APPROVED); if no preview was presented the action is rejected with no status change, and if the status is not DRAFT the action is rejected with HTTP 409 with no status change.
  it('reject (with a valid reason) changes status only when previewed AND DRAFT, else no change', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ALL_STATUSES), fc.boolean(), async (status, previewed) => {
        const { prisma, getDraft } = fakeReviewStore({ id: 'd-1', status, previewPresented: previewed });
        const service = new ReviewService(prisma);
        const result = await throwStatusAsync(() => service.reject('d-1', 'not good enough'));

        const allowed = previewed && status === 'DRAFT';
        if (allowed) {
          expect(result).toBe('ok');
          expect(getDraft().status).toBe('DRAFT'); // reject returns to DRAFT
        } else if (!previewed) {
          // Preview gate fails first -> 409, no change.
          expect(result).toBe(409);
          expect(getDraft().status).toBe(status);
        } else {
          // Previewed but non-DRAFT -> 409, no change.
          expect(result).toBe(409);
          expect(getDraft().status).toBe(status);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 11 — Reject requires a reason and returns the draft to DRAFT
// ===========================================================================

describe('Property 11: Reject requires a reason and returns the draft to DRAFT', () => {
  const reasonArb = fc.oneof(blankArb, fc.constant(undefined as unknown as string), presentArb);

  // Feature: content-pipeline, Property 11: For any reject action on a previewed DRAFT, the action is rejected with HTTP 400 and no status change when the reason is blank or missing; when a non-blank reason is supplied, the reason is stored and the draft's Content_Status is set to DRAFT (editable again).
  it('blank/missing reason -> 400 no change; non-blank reason -> stored + status DRAFT', async () => {
    await fc.assert(
      fc.asyncProperty(reasonArb, async (reason) => {
        const { prisma, getDraft } = fakeReviewStore({ id: 'd-1', status: 'DRAFT', previewPresented: true });
        const service = new ReviewService(prisma);
        const result = await throwStatusAsync(() => service.reject('d-1', reason));

        const reasonOk = typeof reason === 'string' && reason.trim().length > 0;
        if (reasonOk) {
          expect(result).toBe('ok');
          expect(getDraft().status).toBe('DRAFT');
          expect(getDraft().rejectionReason).toBe((reason as string).trim());
        } else {
          expect(result).toBe(400);
          expect(getDraft().status).toBe('DRAFT'); // unchanged (was DRAFT)
          expect(getDraft().rejectionReason).toBe(null); // nothing stored
        }
      }),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Property 12 — Content state-machine transition closure
// ===========================================================================

describe('Property 12: Content state-machine transition closure', () => {
  // Feature: content-pipeline, Property 12: For any pair of Content_Status values (current, target), the state machine permits the transition if and only if the pair is one of DRAFT→APPROVED, APPROVED→SCHEDULED, SCHEDULED→PUBLISHING, PUBLISHING→PUBLISHED, DRAFT→REJECTED, REJECTED→DRAFT, PUBLISHING→FAILED, or FAILED→SCHEDULED; every other pair is rejected with HTTP 409 and leaves the status unchanged.
  it('transition succeeds iff the pair is in the allowed set, else 409', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_STATUSES), fc.constantFrom(...ALL_STATUSES), (a, b) => {
        const r = contentTransition(a, b);
        const allowed = CONTENT_TRANSITIONS.some(([x, y]) => x === a && y === b);
        expect(r.ok).toBe(allowed);
        if (r.ok) {
          expect(r.status).toBe(b);
        } else {
          expect(r.status).toBe(409);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 13 — Scheduling validation per platform
// ===========================================================================

describe('Property 13: Scheduling validation per platform', () => {
  const platformArb = fc.constantFrom('facebook', 'tiktok', 'website');

  // Feature: content-pipeline, Property 13: For any schedule request, no Scheduled_Post is created for the request when the target draft's status is not APPROVED (HTTP 409); and for an approved draft, a Scheduled_Post is created for a selected platform if and only if the publish time is strictly future, and — when the platform is TikTok — the draft has an attached video or photo-carousel Media_Asset and the content description is strictly fewer than 2200 characters including hashtags; a platform failing any applicable gate yields no Scheduled_Post for that platform while other platforms are unaffected.
  it('non-APPROVED draft -> 409 and no Scheduled_Post created', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STATUSES.filter((s) => s !== 'APPROVED')),
        async (status) => {
          const { prisma, created } = fakeSchedulePrisma(
            { id: 'd-1', status, body: 'b', ctas: ['c'] },
            [{ kind: 'video' }],
          );
          const media = new MediaService(prisma, '.');
          const service = new SchedulingService(prisma, media, fixedClock(NOW));
          const future = new Date(NOW.getTime() + 60_000).toISOString();
          const result = await throwStatusAsync(() =>
            service.schedule({ draftId: 'd-1', platforms: ['facebook'], scheduledAt: { facebook: future } }),
          );
          expect(result).toBe(409);
          expect(created).toHaveLength(0);
        },
      ),
      { numRuns: 120 },
    );
  });

  // Feature: content-pipeline, Property 13: For any schedule request, no Scheduled_Post is created for the request when the target draft's status is not APPROVED (HTTP 409); and for an approved draft, a Scheduled_Post is created for a selected platform if and only if the publish time is strictly future, and — when the platform is TikTok — the draft has an attached video or photo-carousel Media_Asset and the content description is strictly fewer than 2200 characters including hashtags; a platform failing any applicable gate yields no Scheduled_Post for that platform while other platforms are unaffected.
  it('an approved draft creates a post per platform iff the platform gate passes', async () => {
    await fc.assert(
      fc.asyncProperty(
        platformArb,
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 3000 }),
        async (platform, offsetMs, hasTikTokMedia, descExtra) => {
          // Build a body whose description length (body only here) lands around the boundary.
          const body = 'x'.repeat(descExtra);
          const assets = hasTikTokMedia ? [{ kind: 'video' }] : [{ kind: 'image' }];
          const { prisma, created } = fakeSchedulePrisma(
            { id: 'd-1', status: 'APPROVED', body, ctas: [] },
            assets,
          );
          const media = new MediaService(prisma, '.');
          const service = new SchedulingService(prisma, media, fixedClock(NOW));
          const scheduledAt = new Date(NOW.getTime() + offsetMs).toISOString();

          const result = await service.schedule({
            draftId: 'd-1',
            platforms: [platform],
            scheduledAt: { [platform]: scheduledAt },
          });

          const future = NOW.getTime() + offsetMs > NOW.getTime();
          let expectedOk = future;
          if (platform === 'tiktok') {
            expectedOk = future && hasTikTokMedia && descExtra < TIKTOK_MAX_DESCRIPTION;
          }

          if (expectedOk) {
            expect(result.created).toHaveLength(1);
            expect(result.rejected).toHaveLength(0);
            expect(created).toHaveLength(1);
          } else {
            expect(result.created).toHaveLength(0);
            expect(result.rejected).toHaveLength(1);
            expect(created).toHaveLength(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: content-pipeline, Property 13: For any schedule request, no Scheduled_Post is created for the request when the target draft's status is not APPROVED (HTTP 409); and for an approved draft, a Scheduled_Post is created for a selected platform if and only if the publish time is strictly future, and — when the platform is TikTok — the draft has an attached video or photo-carousel Media_Asset and the content description is strictly fewer than 2200 characters including hashtags; a platform failing any applicable gate yields no Scheduled_Post for that platform while other platforms are unaffected.
  it('a failing platform is isolated: other platforms still proceed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100_000 }), async (offsetMs) => {
        // facebook with future time passes; tiktok without media fails — independently.
        const { prisma, created } = fakeSchedulePrisma(
          { id: 'd-1', status: 'APPROVED', body: 'b', ctas: [] },
          [{ kind: 'image' }], // not TikTok-eligible
        );
        const media = new MediaService(prisma, '.');
        const service = new SchedulingService(prisma, media, fixedClock(NOW));
        const t = new Date(NOW.getTime() + offsetMs).toISOString();
        const result = await service.schedule({
          draftId: 'd-1',
          platforms: ['facebook', 'tiktok'],
          scheduledAt: { facebook: t, tiktok: t },
        });
        expect(result.created.map((p) => (p as { platform: string }).platform)).toEqual(['facebook']);
        expect(result.rejected.map((r) => r.platform)).toEqual(['tiktok']);
        expect(created).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 14 — Scheduling fan-out and unique idempotency keys
// ===========================================================================

describe('Property 14: Scheduling fan-out and unique idempotency keys', () => {
  // Feature: content-pipeline, Property 14: For any approved draft scheduled to a set of platforms, the service produces exactly one outcome (created or rejected) per selected platform, every created Scheduled_Post starts in status SCHEDULED, and the Idempotency_Keys assigned across all created Scheduled_Posts are pairwise distinct.
  it('exactly one outcome per platform; created posts are SCHEDULED with distinct idempotency keys', async () => {
    const platformSetArb = fc.uniqueArray(fc.constantFrom('facebook', 'tiktok', 'website'), {
      minLength: 1,
      maxLength: 3,
    });
    await fc.assert(
      fc.asyncProperty(
        platformSetArb,
        fc.integer({ min: -100_000, max: 100_000 }),
        async (platforms, offsetMs) => {
          // Provide TikTok-eligible media so TikTok can succeed when time is future.
          const { prisma, created } = fakeSchedulePrisma(
            { id: 'd-1', status: 'APPROVED', body: 'short', ctas: ['cta'] },
            [{ kind: 'video' }],
          );
          const media = new MediaService(prisma, '.');
          const service = new SchedulingService(prisma, media, fixedClock(NOW));
          const t = new Date(NOW.getTime() + offsetMs).toISOString();
          const scheduledAt: Record<string, string> = {};
          for (const p of platforms) scheduledAt[p] = t;

          const result = await service.schedule({ draftId: 'd-1', platforms, scheduledAt });

          // Exactly one outcome per selected platform.
          expect(result.created.length + result.rejected.length).toBe(platforms.length);
          const outcomePlatforms = [
            ...result.created.map((p) => (p as { platform: string }).platform),
            ...result.rejected.map((r) => r.platform),
          ].sort();
          expect(outcomePlatforms).toEqual([...platforms].sort());

          // Every created post starts SCHEDULED.
          for (const p of result.created) {
            expect((p as { status: string }).status).toBe('SCHEDULED');
          }
          // Idempotency keys are pairwise distinct.
          const keys = created.map((c) => c.idempotencyKey as string);
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Property 15 — Due-scan selection predicate
// ===========================================================================

describe('Property 15: Due-scan selection predicate', () => {
  function makeWorker(prisma: PrismaClient): PublishingWorker {
    const registry = registryWith(
      new FakeAdapter('facebook', async () => ({ externalId: 'x', raw: {} })),
    );
    return new PublishingWorker(prisma, registry, okToken, new InMemoryAlertDispatcher(), fixedClock(NOW));
  }

  // Feature: content-pipeline, Property 15: For any set of Scheduled_Posts and any reference time, the Publishing_Worker's due scan returns exactly those posts whose status is SCHEDULED and whose scheduled publish time is at or before the reference time.
  it('scanDue returns exactly the SCHEDULED posts with scheduledAt <= now', async () => {
    const postArb = fc.record({
      id: fc.uuid(),
      status: fc.constantFrom(...ALL_STATUSES),
      offsetMs: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(postArb, { maxLength: 12 }), fc.integer({ min: -500_000, max: 500_000 }), async (raw, refOffset) => {
        const now = new Date(NOW.getTime() + refOffset);
        const posts = raw.map((p) => ({
          id: p.id,
          status: p.status,
          scheduledAt: new Date(NOW.getTime() + p.offsetMs),
        }));
        const prisma = fakeScanPrisma(posts);
        const worker = makeWorker(prisma);
        const due = await worker.scanDue(now);
        const dueIds = new Set(due.map((d) => d.id));

        for (const p of posts) {
          const expected = p.status === 'SCHEDULED' && p.scheduledAt.getTime() <= now.getTime();
          expect(dueIds.has(p.id)).toBe(expected);
        }
      }),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Property 16 — Exclusive idempotency lock before publishing
// ===========================================================================

describe('Property 16: Exclusive idempotency lock before publishing', () => {
  // Feature: content-pipeline, Property 16: For any due Scheduled_Post and any number of concurrent worker processes attempting it, at most one process successfully performs the atomic SCHEDULED→PUBLISHING transition and acquires the lock; a process that does not win the lock, or that encounters a post already in PUBLISHING, invokes no Platform_Adapter operation for that post.
  it('at most one concurrent tryLock wins; the rest do not publish', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 16 }), async (n) => {
        const { prisma, getStatus } = fakeLockPrisma('SCHEDULED');
        const adapter = new FakeAdapter('facebook', async () => ({ externalId: 'x', raw: {} }));
        const worker = new PublishingWorker(prisma, registryWith(adapter), okToken, new InMemoryAlertDispatcher(), fixedClock(NOW));

        // n concurrent contenders all attempt the CAS lock.
        const results = await Promise.all(Array.from({ length: n }, () => worker.tryLock('sp-1')));
        const winners = results.filter((r) => r === true).length;

        expect(winners).toBe(1); // exactly one winner
        expect(getStatus()).toBe('PUBLISHING');
        // Losers performed no publish; only the winner would proceed to the adapter.
        expect(adapter.publishCalls).toHaveLength(0);

        // A subsequent tryLock against an already-PUBLISHING post also loses.
        expect(await worker.tryLock('sp-1')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: content-pipeline, Property 16: For any due Scheduled_Post and any number of concurrent worker processes attempting it, at most one process successfully performs the atomic SCHEDULED→PUBLISHING transition and acquires the lock; a process that does not win the lock, or that encounters a post already in PUBLISHING, invokes no Platform_Adapter operation for that post.
  it('a non-winner that calls publish() on a non-PUBLISHING post invokes no adapter operation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STATUSES.filter((s) => s !== 'PUBLISHING')),
        async (status) => {
          const { prisma } = fakeWorkerPrisma({ status });
          const adapter = new FakeAdapter('facebook', async () => ({ externalId: 'x', raw: {} }));
          const worker = new PublishingWorker(prisma, registryWith(adapter), okToken, new InMemoryAlertDispatcher(), fixedClock(NOW));
          // publish() short-circuits when the post is not PUBLISHING (lost lock).
          await worker.publish('sp-1');
          expect(adapter.publishCalls).toHaveLength(0);
        },
      ),
      { numRuns: 120 },
    );
  });
});

// ===========================================================================
// Property 17 — Token validation failure fails fast without publishing
// ===========================================================================

describe('Property 17: Token validation failure fails fast without publishing', () => {
  // Feature: content-pipeline, Property 17: For any Scheduled_Post whose Platform_Token is invalid and whose refresh fails, the Publishing_Worker sets the post's Content_Status to FAILED with reason TOKEN_EXPIRED, raises an alert to the Content_Manager, and never invokes the Platform_Adapter.
  it('invalid token + failed refresh -> FAILED/TOKEN_EXPIRED + alert + no adapter call', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('facebook', 'tiktok', 'website'), async (platform) => {
        const { prisma, getPost } = fakeWorkerPrisma({ status: 'PUBLISHING', platform });
        const adapter = new FakeAdapter(
          platform === 'website' ? 'custom_cms' : (platform as PlatformId),
          async () => ({ externalId: 'x', raw: {} }),
        );
        const alerts = new InMemoryAlertDispatcher();
        const worker = new PublishingWorker(prisma, registryWith(adapter), deadToken, alerts, fixedClock(NOW));

        const outcome = await worker.publish('sp-1');

        expect(outcome.status).toBe('FAILED');
        expect(getPost().status).toBe('FAILED');
        // The worker records the TOKEN_EXPIRED reason in errorCode.
        expect(getPost().errorCode).toBe('TOKEN_EXPIRED');
        expect(alerts.alerts.length).toBeGreaterThanOrEqual(1);
        expect(adapter.publishCalls).toHaveLength(0); // adapter never invoked
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 18 — Publish request carries the idempotency key
// ===========================================================================

describe('Property 18: Publish request carries the idempotency key', () => {
  // Feature: content-pipeline, Property 18: For any publish invocation the Publishing_Worker makes against a Platform_Adapter, the publish request includes the Idempotency_Key of the Scheduled_Post being published.
  it('every adapter.publish call carries the post idempotency key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (key) => {
        const { prisma } = fakeWorkerPrisma({ status: 'PUBLISHING', platform: 'facebook', idempotencyKey: key });
        const adapter = new FakeAdapter('facebook', async () => ({ externalId: 'ext-1', url: 'u', raw: {} }));
        const worker = new PublishingWorker(prisma, registryWith(adapter), okToken, new InMemoryAlertDispatcher(), fixedClock(NOW));

        await worker.publish('sp-1');

        expect(adapter.publishCalls).toHaveLength(1);
        expect(adapter.publishCalls[0].idempotencyKey).toBe(key);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 19 — Success recording
// ===========================================================================

describe('Property 19: Success recording', () => {
  // Feature: content-pipeline, Property 19: For any successful publish, the Publishing_Worker sets the Scheduled_Post's Content_Status to PUBLISHED even if persisting the returned identifiers fails; and when the adapter returns both an external Post identifier and a post URL, both are stored for that Scheduled_Post.
  it('a successful publish sets PUBLISHED and stores external id + url when both are returned', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.option(fc.webUrl(), { nil: undefined }),
        async (externalId, url) => {
          const { prisma, getPost } = fakeWorkerPrisma({ status: 'PUBLISHING', platform: 'facebook' });
          const adapter = new FakeAdapter('facebook', async () => ({ externalId, url, raw: {} }));
          const worker = new PublishingWorker(prisma, registryWith(adapter), okToken, new InMemoryAlertDispatcher(), fixedClock(NOW));

          const outcome = await worker.publish('sp-1');

          expect(outcome.status).toBe('PUBLISHED');
          expect(getPost().status).toBe('PUBLISHED');
          expect(getPost().externalPostId).toBe(externalId);
          if (url !== undefined) {
            expect(getPost().postUrl).toBe(url);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 20 — Retry and error classification
// ===========================================================================

describe('Property 20: Retry and error classification', () => {
  /** Build an error whose class is known by construction. */
  type ErrSpec = { kind: 'network' | 'http'; status?: number };
  const errSpecArb: fc.Arbitrary<ErrSpec> = fc.oneof(
    fc.constant<ErrSpec>({ kind: 'network' }),
    fc.record({ kind: fc.constant<'http'>('http'), status: fc.constantFrom(400, 401, 403, 404, 422, 429, 500, 502, 503) }),
  );

  function makeError(spec: ErrSpec): unknown {
    if (spec.kind === 'network') return new Error('network timeout');
    return new AppError(spec.status as 400, `HTTP ${spec.status}`, `HTTP_${spec.status}`);
  }

  function expectedClass(spec: ErrSpec): 'transient' | 'hard' {
    if (spec.kind === 'network') return 'transient';
    const s = spec.status as number;
    if (s === 429 || (s >= 500 && s <= 599)) return 'transient';
    return 'hard';
  }

  // Feature: content-pipeline, Property 20: For any publish failure, a Transient_Error (network error, HTTP 429, or HTTP 5xx) is retried with exponential backoff up to a maximum of 3 retries — and once those retries are exhausted the post is set to FAILED with its error code stored and an alert raised as a single combined operation, leaving the status unchanged if any one of those sub-actions fails — whereas a Hard_Error (HTTP 4xx other than 429, or a content-policy violation) sets the post to FAILED with its error code stored and an alert raised, with no retry attempted.
  it('classifyError maps network/429/5xx -> transient and other 4xx -> hard', () => {
    fc.assert(
      fc.property(errSpecArb, (spec) => {
        const classified = classifyError(makeError(spec));
        expect(classified.class).toBe(expectedClass(spec));
      }),
      { numRuns: 200 },
    );
  });

  // Feature: content-pipeline, Property 20: For any publish failure, a Transient_Error (network error, HTTP 429, or HTTP 5xx) is retried with exponential backoff up to a maximum of 3 retries — and once those retries are exhausted the post is set to FAILED with its error code stored and an alert raised as a single combined operation, leaving the status unchanged if any one of those sub-actions fails — whereas a Hard_Error (HTTP 4xx other than 429, or a content-policy violation) sets the post to FAILED with its error code stored and an alert raised, with no retry attempted.
  it('transient errors retry (<=3) then FAIL with alert; hard errors FAIL immediately with no retry', async () => {
    await fc.assert(
      fc.asyncProperty(errSpecArb, fc.integer({ min: 0, max: 5 }), async (spec, retryCount) => {
        const { prisma, getPost } = fakeWorkerPrisma({ status: 'PUBLISHING', platform: 'facebook', retryCount });
        const adapter = new FakeAdapter('facebook', async () => {
          throw makeError(spec);
        });
        const alerts = new InMemoryAlertDispatcher();
        const worker = new PublishingWorker(prisma, registryWith(adapter), okToken, alerts, fixedClock(NOW));

        const outcome = await worker.publish('sp-1');
        const cls = expectedClass(spec);

        if (cls === 'transient' && retryCount < MAX_RETRIES) {
          // Re-scheduled for another attempt; retryCount incremented, no terminal alert.
          expect(outcome.status).toBe('SCHEDULED');
          expect(getPost().status).toBe('SCHEDULED');
          expect(getPost().retryCount).toBe(retryCount + 1);
          expect(alerts.alerts).toHaveLength(0);
        } else {
          // Hard error, or transient with retries exhausted -> terminal FAILED + alert.
          expect(outcome.status).toBe('FAILED');
          expect(getPost().status).toBe('FAILED');
          expect(getPost().errorCode).toBeTruthy();
          expect(alerts.alerts.length).toBeGreaterThanOrEqual(1);
          if (cls === 'hard') {
            // No retry was attempted for a hard error.
            expect(getPost().retryCount).toBe(retryCount);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Property 21 — A draft × platform publishes at most once
// ===========================================================================

describe('Property 21: A draft × platform publishes at most once', () => {
  // Feature: content-pipeline, Property 21: For any sequence of worker runs over a Scheduled_Post — including re-scans after a lost database update and repeated submissions carrying an Idempotency_Key already used for a successful publish — the Platform_Adapter creates no more than one external post for that (draft, platform) pair: when an external Post identifier already exists for the post's Idempotency_Key the worker sets the status to PUBLISHED using that existing identifier without submitting a new publish request, and a re-submitted Idempotency_Key is treated as the original successful publish.
  it('repeated publish() runs invoke the adapter at most once and keep the original external id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.string({ minLength: 1, maxLength: 16 }), async (runs, externalId) => {
        const { prisma, getPost } = fakeWorkerPrisma({ status: 'PUBLISHING', platform: 'facebook' });
        // Adapter returns a fresh id per call so we can detect any duplicate publish.
        let calls = 0;
        const adapter = new FakeAdapter('facebook', async () => {
          calls += 1;
          return { externalId: `${externalId}-${calls}`, url: 'u', raw: {} };
        });
        const worker = new PublishingWorker(prisma, registryWith(adapter), okToken, new InMemoryAlertDispatcher(), fixedClock(NOW));

        // First run publishes; subsequent runs see an existing external id (re-scan
        // after a "lost update" leaving status=PUBLISHING) and must not re-publish.
        const firstId = `${externalId}-1`;
        for (let i = 0; i < runs; i++) {
          await worker.publish('sp-1');
        }

        expect(adapter.publishCalls.length).toBe(1); // at most once
        expect(getPost().status).toBe('PUBLISHED');
        expect(getPost().externalPostId).toBe(firstId); // original id preserved
      }),
      { numRuns: 120 },
    );
  });

  // Feature: content-pipeline, Property 21: For any sequence of worker runs over a Scheduled_Post — including re-scans after a lost database update and repeated submissions carrying an Idempotency_Key already used for a successful publish — the Platform_Adapter creates no more than one external post for that (draft, platform) pair: when an external Post identifier already exists for the post's Idempotency_Key the worker sets the status to PUBLISHED using that existing identifier without submitting a new publish request, and a re-submitted Idempotency_Key is treated as the original successful publish.
  it('a PUBLISHING post that already has an external id is reconciled without any adapter call', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 16 }), async (existingId) => {
        const { prisma, getPost } = fakeWorkerPrisma({
          status: 'PUBLISHING',
          platform: 'facebook',
          externalPostId: existingId,
          postUrl: 'https://example.com/p',
        });
        const adapter = new FakeAdapter('facebook', async () => ({ externalId: 'SHOULD-NOT-HAPPEN', raw: {} }));
        const worker = new PublishingWorker(prisma, registryWith(adapter), okToken, new InMemoryAlertDispatcher(), fixedClock(NOW));

        const outcome = await worker.publish('sp-1');

        expect(adapter.publishCalls).toHaveLength(0); // no new publish request
        expect(outcome.status).toBe('PUBLISHED');
        expect(getPost().externalPostId).toBe(existingId); // original id used
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 22 — Failed-post recovery validity
// ===========================================================================

describe('Property 22: Failed-post recovery validity', () => {
  // Feature: content-pipeline, Property 22: For any reschedule request against a FAILED Scheduled_Post, the service transitions it to SCHEDULED with the new time if and only if the new time is strictly future and the edited post satisfies the scheduling gates of Requirement 12 criteria 3 through 5; otherwise it rejects the request and leaves the Content_Status unchanged.
  it('retryFailed transitions FAILED->SCHEDULED iff future time and platform gates pass', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('facebook', 'tiktok', 'website'),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.boolean(),
        async (platform, offsetMs, hasTikTokMedia) => {
          const assets = hasTikTokMedia ? [{ kind: 'video' }] : [{ kind: 'image' }];
          const { prisma, getPost } = fakeRetryPrisma(
            { id: 'sp-1', status: 'FAILED', platform },
            { id: 'd-1', body: 'short body', ctas: ['cta'] },
            assets,
          );
          const media = new MediaService(prisma, '.');
          const service = new SchedulingService(prisma, media, fixedClock(NOW));
          const newTime = new Date(NOW.getTime() + offsetMs);

          const future = newTime.getTime() > NOW.getTime();
          let expectedOk = future;
          if (platform === 'tiktok') expectedOk = future && hasTikTokMedia; // description is short

          let ok = false;
          try {
            await service.retryFailed('sp-1', newTime);
            ok = true;
          } catch {
            ok = false;
          }

          expect(ok).toBe(expectedOk);
          if (expectedOk) {
            expect(getPost().status).toBe('SCHEDULED');
          } else {
            expect(getPost().status).toBe('FAILED'); // unchanged
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: content-pipeline, Property 22: For any reschedule request against a FAILED Scheduled_Post, the service transitions it to SCHEDULED with the new time if and only if the new time is strictly future and the edited post satisfies the scheduling gates of Requirement 12 criteria 3 through 5; otherwise it rejects the request and leaves the Content_Status unchanged.
  it('a non-FAILED post cannot be recovered (409, status unchanged)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STATUSES.filter((s) => s !== 'FAILED')),
        async (status) => {
          const { prisma, getPost } = fakeRetryPrisma(
            { id: 'sp-1', status, platform: 'facebook' },
            { id: 'd-1', body: 'b', ctas: ['c'] },
            [{ kind: 'video' }],
          );
          const media = new MediaService(prisma, '.');
          const service = new SchedulingService(prisma, media, fixedClock(NOW));
          const result = await throwStatusAsync(() => service.retryFailed('sp-1', new Date(NOW.getTime() + 60_000)));
          expect(result).toBe(409);
          expect(getPost().status).toBe(status);
        },
      ),
      { numRuns: 120 },
    );
  });
});

// ===========================================================================
// Property 23 — Calendar status colors are distinct
// ===========================================================================

describe('Property 23: Calendar status colors are distinct', () => {
  const COLORED: ContentStatus[] = ['SCHEDULED', 'PUBLISHED', 'DRAFT', 'FAILED'];

  // Feature: content-pipeline, Property 23: For any two distinct Content_Status values among {SCHEDULED, PUBLISHED, DRAFT, FAILED}, the Calendar_Manager assigns them different colors (the color mapping is injective over these four statuses).
  it('colorFor is injective over {SCHEDULED, PUBLISHED, DRAFT, FAILED}', () => {
    fc.assert(
      fc.property(fc.constantFrom(...COLORED), fc.constantFrom(...COLORED), (a, b) => {
        if (a === b) {
          expect(colorFor(a)).toBe(colorFor(b));
        } else {
          expect(colorFor(a)).not.toBe(colorFor(b));
        }
      }),
      { numRuns: 100 },
    );
    // Exhaustive distinctness check.
    const colors = COLORED.map(colorFor);
    expect(new Set(colors).size).toBe(COLORED.length);
  });
});
