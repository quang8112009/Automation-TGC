/**
 * Content Pipeline route registration (Content Pipeline Req 19).
 *
 * All routes are mounted behind the Foundation authentication + RBAC middleware:
 *   - /api/strategy/*      -> module 'strategy'
 *   - /api/generation/*    -> module 'generation'
 *   - /api/media           -> module 'generation'
 *   - /api/publishing/*    -> module 'publishing'
 * RBAC makes these ADMIN-only (SALES has no write access to these modules).
 *
 * This file does NOT touch routes/index.ts; it exports a registrar that the
 * application can call additively.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../infra/config';
import type { JwtService } from '../auth/jwt';
import type { AdapterRegistry } from '../platforms/registry';
import type { AlertDispatcher } from '../infra/alerts';
import type { EventBus } from '../infra/events';
import { requireAuth, rbacGuard } from '../http/authMiddleware';
import type { Action, Module } from '../auth/rbac';
import { ValidationError } from '../infra/errors';
import { PersonaService } from '../strategy/personaService';
import type { ContentGenerator } from '../strategy/personaService';
import { CalendarService } from './calendarService';
import type { CalendarView } from './calendarService';
import { GenerationService, PrismaAiPromptContextReader } from './generationService';
import type { AiPromptContextReader } from './generationService';
import { MediaService } from './mediaService';
import { DraftService } from './draftService';
import { ReviewService } from './reviewService';
import { SchedulingService } from './schedulingService';
import { PublishingWorker } from './publishingWorker';
import type { TokenChecker } from './publishingWorker';

export interface ContentRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  config: AppConfig;
  gemini: ContentGenerator;
  registry: AdapterRegistry;
  tokenManager: TokenChecker;
  alerts: AlertDispatcher;
  mediaService: MediaService;
  /** Optional override; defaults to the Prisma-backed reader. */
  aiContextReader?: AiPromptContextReader;
  /** Shared domain event bus; when present, draft/scheduled-post events publish. */
  eventBus?: EventBus;
}

interface IdParams {
  id: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function guard(module: Module, action: Action) {
  return rbacGuard(() => ({ module, action }));
}

export async function registerContentRoutes(app: FastifyInstance, deps: ContentRouteDeps): Promise<void> {
  const { prisma, jwt, gemini, registry, tokenManager, alerts, mediaService } = deps;
  const auth = requireAuth({ prisma, jwt });

  const personaService = new PersonaService(prisma, gemini);
  const calendarService = new CalendarService(prisma);
  const aiContextReader = deps.aiContextReader ?? new PrismaAiPromptContextReader(prisma);
  const generationService = new GenerationService(prisma, gemini, aiContextReader);
  const draftService = new DraftService(prisma);
  const reviewService = new ReviewService(prisma, deps.eventBus);
  const schedulingService = new SchedulingService(prisma, mediaService, undefined, deps.eventBus);
  const worker = new PublishingWorker(prisma, registry, tokenManager, alerts, undefined, deps.eventBus);

  // ---- Strategy: Persona -----------------------------------------------------
  // List personas (read). The Strategy page uses this to render all saved
  // personas, not just ones created in the current browser session.
  app.get(
    '/api/strategy/personas',
    { preHandler: [auth, guard('strategy', 'read')] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await personaService.list(
        { domainName: asString(q.domainName) },
        asInt(q.page, 1),
        asInt(q.limit, 50),
      );
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/strategy/personas/:id',
    { preHandler: [auth, guard('strategy', 'read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const persona = await personaService.get(id);
      return reply.code(200).send(persona);
    },
  );

  app.post(
    '/api/strategy/persona',
    { preHandler: [auth, guard('strategy', 'create')] },
    async (request, reply) => {
      const persona = await personaService.create((request.body ?? {}) as Record<string, unknown>);
      return reply.code(201).send(persona);
    },
  );

  app.put(
    '/api/strategy/persona/:id',
    { preHandler: [auth, guard('strategy', 'update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const persona = await personaService.update(id, (request.body ?? {}) as Record<string, unknown>);
      return reply.code(200).send(persona);
    },
  );

  app.get(
    '/api/strategy/persona/:id/recommendations',
    { preHandler: [auth, guard('strategy', 'read')] },
    async (request, reply) => {
      // The :id segment carries the domain name for which to recommend.
      const { id } = request.params as IdParams;
      const q = (request.query ?? {}) as Record<string, unknown>;
      const domainName = asString(q.domainName) ?? id;
      const suggestion = await personaService.recommend(domainName);
      return reply.code(200).send(suggestion);
    },
  );

  // ---- Strategy: Calendar ----------------------------------------------------
  app.get(
    '/api/strategy/calendar',
    { preHandler: [auth, guard('strategy', 'read')] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const view = parseView(asString(q.view));
      const reference = parseDate(asString(q.date));
      const result = await calendarService.getCalendar(view, reference);
      return reply.code(200).send(result);
    },
  );

  app.put(
    '/api/strategy/calendar/:id/reschedule',
    { preHandler: [auth, guard('strategy', 'update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const newTime = parseDate(asString(body.scheduledAt));
      if (!newTime) {
        throw new ValidationError('scheduledAt is required', 'RESCHEDULE_TIME_REQUIRED');
      }
      const result = await calendarService.reschedule(id, newTime);
      return reply.code(200).send(result);
    },
  );

  // ---- Generation ------------------------------------------------------------
  app.post(
    '/api/generation/generate',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await generationService.generate({
        domainName: asString(body.domainName),
        personaIds: asStringArray(body.personaIds),
        objective: asString(body.objective),
      });
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/api/generation/drafts',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const result = await draftService.list(asInt(q.page, 1), asInt(q.limit, 20));
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/generation/drafts/:id',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const draft = await draftService.get(id);
      return reply.code(200).send(draft);
    },
  );

  app.put(
    '/api/generation/drafts/:id',
    { preHandler: [auth, guard('generation', 'update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const draft = await draftService.edit(id, {
        title: asString(body.title),
        body: asString(body.body),
        ctas: body.ctas !== undefined ? asStringArray(body.ctas) : undefined,
      });
      return reply.code(200).send(draft);
    },
  );

  app.delete(
    '/api/generation/drafts/:id',
    { preHandler: [auth, guard('generation', 'delete')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const q = (request.query ?? {}) as Record<string, unknown>;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const confirmed = q.confirm === 'true' || body.confirm === true;
      if (!confirmed) {
        const pending = await draftService.requestDelete(id);
        return reply.code(200).send(pending);
      }
      const result = await draftService.confirmDelete(id);
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/generation/drafts/:id/review',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const draft = await reviewService.preview(id);
      return reply.code(200).send(draft);
    },
  );

  app.post(
    '/api/generation/drafts/:id/approve',
    { preHandler: [auth, guard('generation', 'status_update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const draft = await reviewService.approve(id);
      return reply.code(200).send(draft);
    },
  );

  app.post(
    '/api/generation/drafts/:id/reject',
    { preHandler: [auth, guard('generation', 'status_update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const draft = await reviewService.reject(id, asString(body.reason) ?? '');
      return reply.code(200).send(draft);
    },
  );

  // Self-Correction loop (proposal 3.1): instead of discarding a rejected draft,
  // rewrite it in place using the stored rejection reason (or an override sent
  // in the body). Returns the regenerated draft (still DRAFT, preview reset).
  app.post(
    '/api/generation/drafts/:id/regenerate',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await generationService.regenerateFromRejection(id, asString(body.reason));
      return reply.code(200).send(result);
    },
  );

  // ---- Media (JSON base64 upload for simplicity) -----------------------------
  app.post(
    '/api/media',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const draftId = asString(body.draftId);
      const filename = asString(body.filename);
      const mimeType = asString(body.mimeType);
      const contentBase64 = asString(body.contentBase64);
      if (!draftId || !filename || !mimeType || !contentBase64) {
        throw new ValidationError(
          'draftId, filename, mimeType, and contentBase64 are required',
          'MEDIA_FIELDS_REQUIRED',
        );
      }
      const buffer = decodeBase64(contentBase64);
      const asset = await mediaService.attach(draftId, { filename, mimetype: mimeType, buffer });
      return reply.code(201).send(asset);
    },
  );

  // ---- Publishing: Scheduling ------------------------------------------------
  app.post(
    '/api/publishing/schedule',
    { preHandler: [auth, guard('publishing', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const draftId = asString(body.draftId);
      if (!draftId) {
        throw new ValidationError('draftId is required', 'SCHEDULE_DRAFT_REQUIRED');
      }
      const platforms = asStringArray(body.platforms);
      const scheduledAt = isRecordOfStrings(body.scheduledAt) ? body.scheduledAt : {};
      const result = await schedulingService.schedule({ draftId, platforms, scheduledAt });
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/api/publishing/scheduled/:id/retry',
    { preHandler: [auth, guard('publishing', 'update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const newTime = parseDate(asString(body.scheduledAt));
      if (!newTime) {
        throw new ValidationError('scheduledAt is required', 'RETRY_TIME_REQUIRED');
      }
      const post = await schedulingService.retryFailed(id, newTime);
      return reply.code(200).send(post);
    },
  );

  // ---- Publishing: worker trigger (background-worker / ADMIN) -----------------
  app.post(
    '/api/publishing/post',
    { preHandler: [auth, guard('publishing', 'status_update')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const postId = asString(body.scheduledPostId) ?? asString(body.id);
      if (!postId) {
        throw new ValidationError('scheduledPostId is required', 'PUBLISH_ID_REQUIRED');
      }
      const locked = await worker.tryLock(postId);
      if (!locked) {
        const fresh = await prisma.scheduledPost.findUnique({ where: { id: postId } });
        return reply.code(200).send({ postId, status: fresh?.status ?? 'UNKNOWN', locked: false });
      }
      const outcome = await worker.publish(postId);
      return reply.code(200).send({ ...outcome, locked: true });
    },
  );
}

function parseView(value: string | undefined): CalendarView {
  if (value === 'month' || value === 'week' || value === 'day') return value;
  return 'month';
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function decodeBase64(value: string): Buffer {
  try {
    return Buffer.from(value, 'base64');
  } catch {
    throw new ValidationError('contentBase64 is not valid base64', 'MEDIA_BASE64_INVALID');
  }
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}
