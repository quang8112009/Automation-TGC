/**
 * Additional property-based tests for the content-pipeline spec.
 *
 * Scope: the strong-candidate gaps relative to `test/content.test.ts`
 * (prompt ordering, cold-start, generation output shape, the per-platform
 * scheduling gate / TikTok boundary, reschedule validity, calendar color
 * injectivity) and `test/stateMachines.test.ts` (state-machine closure):
 *
 *   - Property 5  — Generation request validation
 *   - Property 9  — Draft edit guard
 *   - Property 10 — Review actions gated by preview + DRAFT status
 *   - Property 11 — Reject requires a reason and returns the draft to DRAFT
 *   - Property 14 — Scheduling fan-out and unique idempotency keys
 *   - Property 20 — Retry and error classification
 *
 * Every test is tagged `// Feature: content-pipeline, Property {n}: ...` and runs
 * fast-check with `numRuns >= 100`. Determinism: Gemini, the Platform_Adapter,
 * the Token_Manager and the Alert Dispatcher are mocked; the clock is injected;
 * PostgreSQL/Redis are exercised through local in-memory repository fakes (the
 * same style as `test/content.test.ts`). No `src/` file is modified — only
 * existing exports are used.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../src/auth/jwt';

import { GenerationService } from '../src/content/generationService';
import type { Objective } from '../src/content/generationService';
import { DraftService } from '../src/content/draftService';
import { ReviewService } from '../src/content/reviewService';
import { SchedulingService, TIKTOK_MAX_DESCRIPTION } from '../src/content/schedulingService';
import { MediaService } from '../src/content/mediaService';
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
import type { AllowedStatus } from '../src/infra/errors';
import type { ContentStatus } from '../src/content/stateMachine';

// ---------------------------------------------------------------------------
// Shared helpers / test doubles
// ---------------------------------------------------------------------------

const NOW = new Date('2025-06-01T00:00:00.000Z');
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

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

/** Returns the AppError status thrown by `fn`, or 'ok' when it returns normally. */
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

/** True iff `s` is a non-blank string (mirrors the services' blank check). */
function nonBlank(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

/** A canned valid Gemini response (title + body + >=1 CTA). */
const CANNED_CONTENT = JSON.stringify({
  title: 'A Title',
  body: 'A body of content.',
  ctas: ['Buy now'],
});

/** Gemini double that returns a fixed response. */
function gemini(response: string): { generateContent: (p: string) => Promise<string> } {
  return { generateContent: async () => response };
}

/** Platform_Adapter double that records publish() calls and runs a behavior. */
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

const okToken: TokenChecker = { isValid: async () => true, refresh: async () => undefined };

function registryWith(adapter: PlatformAdapter): AdapterRegistry {
  return new AdapterRegistry().register(adapter);
}

// ---------------------------------------------------------------------------
// In-memory Prisma fakes (local to this file)
// ---------------------------------------------------------------------------

/** Generation fake: one domain + one persona; records created drafts (P5). */
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

/** Single-draft store backing DraftService.edit (P9). */
function fakeDraftEditStore(initial: {
  id: string;
  title: string;
  body: string;
  status: string;
  ctas: string[];
}): { prisma: PrismaClient; getDraft: () => { id: string; title: string; body: string; status: string } } {
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
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ contentDraft: draftModel, draftCta: ctaModel }),
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
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === draft.id ? { ...draft } : null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(draft, args.data);
        return { ...draft };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, getDraft: () => ({ ...draft }) };
}

/** Scheduling fake: one draft + configurable media assets; records posts (P14). */
function fakeSchedulePrisma(
  draft: { id: string; status: string; body: string; ctas: string[] },
  assets: Array<{ kind: string }>,
): { prisma: PrismaClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  let seq = 0;
  const prisma = {
    contentDraft: {
      findUnique: async (args: { where: { id: string } }) => {
        if (args.where.id !== draft.id) return null;
        return {
          id: draft.id,
          status: draft.status,
          body: draft.body,
          ctas: draft.ctas.map((ctaText) => ({ ctaText })),
        };
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

/** Worker fake backing PublishingWorker.publish (P20). */
function fakeWorkerPrisma(opts: {
  status?: string;
  platform?: string;
  idempotencyKey?: string;
  retryCount?: number;
}): { prisma: PrismaClient; getPost: () => Record<string, unknown> } {
  const post: Record<string, unknown> = {
    id: 'sp-1',
    draftId: 'd-1',
    platform: opts.platform ?? 'facebook',
    status: opts.status ?? 'PUBLISHING',
    idempotencyKey: opts.idempotencyKey ?? 'idem-1',
    externalPostId: null,
    postUrl: null,
    errorCode: null,
    failureReason: null,
    retryCount: opts.retryCount ?? 0,
  };
  const draft = { id: 'd-1', title: 'Title', body: 'Body', ctas: [{ ctaText: 'Buy' }], media: [] as unknown[] };
  const prisma = {
    scheduledPost: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === post.id ? { ...post } : null,
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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const blankArb = fc.constantFrom('', ' ', '   ', '\t', '\n', '  \t ');
const presentArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0);

// ===========================================================================

describe('content-pipeline properties', () => {
  // =========================================================================
  // Property 5 — Generation request validation
  // =========================================================================
  describe('Property 5: Generation request validation', () => {
    const reqArb = fc.record({
      domainName: fc.oneof(presentArb, blankArb, fc.constant(undefined)),
      personaIds: fc.oneof(
        fc.array(fc.oneof(presentArb, blankArb), { maxLength: 3 }),
        fc.constant(undefined),
      ),
      objective: fc.oneof(
        fc.constantFrom(...OBJECTIVES) as fc.Arbitrary<string>,
        presentArb,
        fc.constant(undefined),
      ),
    });

    function expectedOk(req: {
      domainName?: string;
      personaIds?: string[];
      objective?: string;
    }): boolean {
      const domainOk = nonBlank(req.domainName);
      const personaOk = Array.isArray(req.personaIds) && req.personaIds.some((id) => nonBlank(id));
      const objectiveOk =
        typeof req.objective === 'string' && (OBJECTIVES as string[]).includes(req.objective);
      return domainOk && personaOk && objectiveOk;
    }

    // Feature: content-pipeline, Property 5: For any generation request, the Generation_Service proceeds to generate if and only if a domain is provided, at least one Content_Persona is selected, and the objective is one of {Lead, View, Follow}; otherwise it rejects with HTTP 400 and produces no Content_Draft.
    it('validate accepts iff domain present, >=1 persona, and objective in {Lead,View,Follow}', () => {
      fc.assert(
        fc.property(reqArb, (req) => {
          const { prisma } = fakeGenerationPrisma();
          const service = new GenerationService(prisma, gemini(CANNED_CONTENT), { get: async () => null });
          const result = throwStatus(() => service.validate(req));
          expect(result).toBe(expectedOk(req) ? 'ok' : 400);
        }),
        { numRuns: 300 },
      );
    });

    // Feature: content-pipeline, Property 5: For any generation request, the Generation_Service proceeds to generate if and only if a domain is provided, at least one Content_Persona is selected, and the objective is one of {Lead, View, Follow}; otherwise it rejects with HTTP 400 and produces no Content_Draft.
    it('an invalid request rejects with 400 and persists no Content_Draft', async () => {
      await fc.assert(
        fc.asyncProperty(reqArb, async (req) => {
          fc.pre(!expectedOk(req)); // focus on the invalid branch
          const { prisma, created } = fakeGenerationPrisma();
          const service = new GenerationService(prisma, gemini(CANNED_CONTENT), { get: async () => null });
          const result = await throwStatusAsync(() => service.generate(req));
          expect(result).toBe(400);
          expect(created).toHaveLength(0);
        }),
        { numRuns: 200 },
      );
    });
  });

  // =========================================================================
  // Property 9 — Draft edit guard
  // =========================================================================
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
              expect(getDraft().title).toBe('orig-title');
              expect(getDraft().body).toBe('orig-body');
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // =========================================================================
  // Property 10 — Review actions gated by preview and DRAFT status
  // =========================================================================
  describe('Property 10: Review actions gated by preview and DRAFT status', () => {
    // Feature: content-pipeline, Property 10: For any Content_Draft, an approve or reject action changes the Content_Status only if a preview has been presented for that draft and the draft's status is DRAFT (a previewed DRAFT approve yields APPROVED); if no preview was presented the action is rejected with no status change, and if the status is not DRAFT the action is rejected with HTTP 409 with no status change.
    it('approve changes status only when previewed AND DRAFT (-> APPROVED), else no change', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...ALL_STATUSES), fc.boolean(), async (status, previewed) => {
          const { prisma, getDraft } = fakeReviewStore({ id: 'd-1', status, previewPresented: previewed });
          const service = new ReviewService(prisma);
          const result = await throwStatusAsync(() => service.approve('d-1'));

          if (previewed && status === 'DRAFT') {
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
    it('reject (with a valid reason) changes status only when previewed AND DRAFT, else 409 no change', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...ALL_STATUSES), fc.boolean(), async (status, previewed) => {
          const { prisma, getDraft } = fakeReviewStore({ id: 'd-1', status, previewPresented: previewed });
          const service = new ReviewService(prisma);
          const result = await throwStatusAsync(() => service.reject('d-1', 'not good enough'));

          if (previewed && status === 'DRAFT') {
            expect(result).toBe('ok');
            expect(getDraft().status).toBe('DRAFT'); // reject returns to DRAFT
          } else {
            expect(result).toBe(409);
            expect(getDraft().status).toBe(status); // unchanged
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  // =========================================================================
  // Property 11 — Reject requires a reason and returns the draft to DRAFT
  // =========================================================================
  describe('Property 11: Reject requires a reason and returns the draft to DRAFT', () => {
    const reasonArb = fc.oneof(blankArb, fc.constant(undefined as unknown as string), presentArb);

    // Feature: content-pipeline, Property 11: For any reject action on a previewed DRAFT, the action is rejected with HTTP 400 and no status change when the reason is blank or missing; when a non-blank reason is supplied, the reason is stored and the draft's Content_Status is set to DRAFT (editable again).
    it('blank/missing reason -> 400 no change; non-blank reason -> stored + status DRAFT', async () => {
      await fc.assert(
        fc.asyncProperty(reasonArb, async (reason) => {
          const { prisma, getDraft } = fakeReviewStore({ id: 'd-1', status: 'DRAFT', previewPresented: true });
          const service = new ReviewService(prisma);
          const result = await throwStatusAsync(() => service.reject('d-1', reason));

          if (nonBlank(reason)) {
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

  // =========================================================================
  // Property 14 — Scheduling fan-out and unique idempotency keys
  // =========================================================================
  describe('Property 14: Scheduling fan-out and unique idempotency keys', () => {
    const platformSetArb = fc.uniqueArray(fc.constantFrom('facebook', 'tiktok', 'website'), {
      minLength: 1,
      maxLength: 3,
    });

    // Feature: content-pipeline, Property 14: For any approved draft scheduled to a set of platforms, the service produces exactly one outcome (created or rejected) per selected platform, every created Scheduled_Post starts in status SCHEDULED, and the Idempotency_Keys assigned across all created Scheduled_Posts are pairwise distinct.
    it('exactly one outcome per platform; created posts are SCHEDULED with distinct idempotency keys', async () => {
      await fc.assert(
        fc.asyncProperty(
          platformSetArb,
          fc.integer({ min: -100_000, max: 100_000 }),
          async (platforms, offsetMs) => {
            // TikTok-eligible media + short description so TikTok can succeed when future.
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

            // Idempotency keys are pairwise distinct (and present) across created posts.
            const keys = created.map((c) => c.idempotencyKey as string);
            for (const k of keys) expect(typeof k).toBe('string');
            expect(new Set(keys).size).toBe(keys.length);
          },
        ),
        { numRuns: 150 },
      );
    });
  });

  // =========================================================================
  // Property 20 — Retry and error classification
  // =========================================================================
  describe('Property 20: Retry and error classification', () => {
    type ErrSpec = { kind: 'network' } | { kind: 'http'; status: number };
    const errSpecArb: fc.Arbitrary<ErrSpec> = fc.oneof(
      fc.constant<ErrSpec>({ kind: 'network' }),
      fc.record({
        kind: fc.constant<'http'>('http'),
        status: fc.constantFrom(400, 401, 403, 404, 422, 429, 500, 502, 503),
      }),
    );

    function makeError(spec: ErrSpec): unknown {
      if (spec.kind === 'network') return new Error('network timeout');
      return new AppError(spec.status as AllowedStatus, `HTTP ${spec.status}`, `HTTP_${spec.status}`);
    }

    function expectedClass(spec: ErrSpec): 'transient' | 'hard' {
      if (spec.kind === 'network') return 'transient';
      const s = spec.status;
      return s === 429 || (s >= 500 && s <= 599) ? 'transient' : 'hard';
    }

    // Feature: content-pipeline, Property 20: For any publish failure, a Transient_Error (network error, HTTP 429, or HTTP 5xx) is retried with exponential backoff up to a maximum of 3 retries — and once those retries are exhausted the post is set to FAILED with its error code stored and an alert raised as a single combined operation, leaving the status unchanged if any one of those sub-actions fails — whereas a Hard_Error (HTTP 4xx other than 429, or a content-policy violation) sets the post to FAILED with its error code stored and an alert raised, with no retry attempted.
    it('classifyError maps network/429/5xx -> transient and other 4xx -> hard', () => {
      fc.assert(
        fc.property(errSpecArb, (spec) => {
          expect(classifyError(makeError(spec)).class).toBe(expectedClass(spec));
        }),
        { numRuns: 200 },
      );
    });

    // Feature: content-pipeline, Property 20: For any publish failure, a Transient_Error (network error, HTTP 429, or HTTP 5xx) is retried with exponential backoff up to a maximum of 3 retries — and once those retries are exhausted the post is set to FAILED with its error code stored and an alert raised as a single combined operation, leaving the status unchanged if any one of those sub-actions fails — whereas a Hard_Error (HTTP 4xx other than 429, or a content-policy violation) sets the post to FAILED with its error code stored and an alert raised, with no retry attempted.
    it('transient errors retry (<=3) then FAIL+alert; hard errors FAIL immediately with no retry', async () => {
      await fc.assert(
        fc.asyncProperty(errSpecArb, fc.integer({ min: 0, max: 5 }), async (spec, retryCount) => {
          const { prisma, getPost } = fakeWorkerPrisma({
            status: 'PUBLISHING',
            platform: 'facebook',
            retryCount,
          });
          const adapter = new FakeAdapter('facebook', async () => {
            throw makeError(spec);
          });
          const alerts = new InMemoryAlertDispatcher();
          const worker = new PublishingWorker(
            prisma,
            registryWith(adapter),
            okToken,
            alerts,
            fixedClock(NOW),
          );

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
              expect(getPost().retryCount).toBe(retryCount); // no retry for a hard error
            }
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
