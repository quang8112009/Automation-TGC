/**
 * HTTP routes for multi-format AI content generation (marketing autopilot).
 * Thin layer — shapes requests/responses, wires auth + RBAC, and delegates to
 * MultiFormatGenerator. The Prisma-backed AI_Prompt_Context reader is constructed
 * here (same seam GenerationService uses).
 *
 * RBAC: every route is behind requireAuth + rbacGuard with module 'generation'
 * (ADMIN-only by current policy — SALES is denied on the generation module).
 *
 * Generation requires a configured Gemini key: a misconfigured AI surfaces as a
 * 502 (AI_NOT_CONFIGURED) AFTER request validation (400s) has passed. This file
 * does NOT touch routes/index.ts or app.ts; it exports an additive registrar.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../../auth/jwt';
import type { ContentGenerator } from '../../strategy/personaService';
import { requireAuth, rbacGuard } from '../../http/authMiddleware';
import { PrismaAiPromptContextReader } from '../../content/generationService';
import { CONTENT_FORMATS, FORMAT_META } from './formats';
import { MultiFormatGenerator } from './multiFormatGenerator';
import type { BrandKnowledgeProvider } from '../brandKnowledge';

export interface MultiFormatRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /** Gemini seam; generation rethrows 502 AI_NOT_CONFIGURED when unconfigured. */
  gemini: ContentGenerator;
  /** Optional brand-knowledge grounding seam; when present prompts are grounded. */
  brandKnowledge?: BrandKnowledgeProvider;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

export function registerMultiFormatRoutes(app: FastifyInstance, deps: MultiFormatRouteDeps): void {
  const { prisma, jwt, gemini, brandKnowledge } = deps;
  const aiContextReader = new PrismaAiPromptContextReader(prisma);
  const generator = new MultiFormatGenerator(prisma, gemini, aiContextReader, brandKnowledge);
  const auth = requireAuth({ prisma, jwt });

  const genRead = rbacGuard(() => ({ module: 'generation', action: 'read' }));
  const genCreate = rbacGuard(() => ({ module: 'generation', action: 'create' }));

  // ---- Multi-format generation ----------------------------------------------
  app.post(
    '/api/v1/generation/multi-format',
    { preHandler: [auth, genCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await generator.generate({
        format: asString(body.format),
        domainName: asString(body.domainName),
        personaIds: asStringArray(body.personaIds) ?? [],
        objective: asString(body.objective),
        market: asString(body.market),
        topic: asString(body.topic),
        keyword: asString(body.keyword),
        seoKeywords: asStringArray(body.seoKeywords),
        planItemId: asString(body.planItemId),
      });
      return reply.code(201).send(result);
    },
  );

  // ---- Multi-format generation (STREAMING via SSE) --------------------------
  // Streams user-facing content deltas as they arrive so the UI shows progress
  // instead of a long spinner, then emits a terminal `done` event carrying the
  // persisted draft (identical persistence to the non-streaming route). Request
  // validation runs BEFORE the reply is hijacked, so a 400 returns the normal
  // { error } envelope. Failures AFTER streaming starts (AI 502, parse) are sent
  // as an SSE `error` frame instead.
  app.post(
    '/api/v1/generation/multi-format/stream',
    { preHandler: [auth, genCreate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const req = {
        format: asString(body.format),
        domainName: asString(body.domainName),
        personaIds: asStringArray(body.personaIds) ?? [],
        objective: asString(body.objective),
        market: asString(body.market),
        topic: asString(body.topic),
        keyword: asString(body.keyword),
        seoKeywords: asStringArray(body.seoKeywords),
        planItemId: asString(body.planItemId),
      };

      // Validate input BEFORE switching to streaming mode so a 400 surfaces as a
      // normal envelope via the global error handler (not an SSE frame).
      generator.validate(req);

      // Take over the raw response for Server-Sent Events.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // disable nginx proxy buffering for this stream
      });
      raw.write(': connected\n\n');

      // Stop writing once the client disconnects (avoids EPIPE on a closed
      // socket and lets us short-circuit forwarding). The upstream AI call still
      // runs to completion, but we no longer push to a dead socket.
      let clientGone = false;
      raw.on('close', () => {
        clientGone = true;
      });

      const send = (event: string, data: unknown): void => {
        if (clientGone || raw.writableEnded) return;
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const result = await generator.generateStreaming(req, (chunk) => {
          send('delta', { text: chunk });
        });
        send('done', result);
      } catch (err) {
        // Only surface the typed error CODE + status plus a safe, generic
        // message. The raw err.message is deliberately NOT sent over the wire:
        // this frame bypasses the global error handler's redaction, so echoing
        // an arbitrary message could leak PII/secret fragments from an
        // unexpected error. The status lets the client classify correctly
        // (e.g. a 404 persona-not-found must NOT render as the 502
        // "AI unconfigured" notice).
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
            : 'GENERATION_FAILED';
        const status =
          err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number'
            ? (err as { status: number }).status
            : 500;
        send('error', { error: { code, message: 'Generation failed', status } });
      } finally {
        if (!raw.writableEnded) raw.end();
      }
    },
  );

  // ---- Format catalog (read) -------------------------------------------------
  app.get(
    '/api/v1/generation/formats',
    { preHandler: [auth, genRead] },
    async (_request, reply) => {
      return reply.code(200).send({ formats: CONTENT_FORMATS, meta: FORMAT_META });
    },
  );
}
