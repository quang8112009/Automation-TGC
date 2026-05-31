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

  // ---- Format catalog (read) -------------------------------------------------
  app.get(
    '/api/v1/generation/formats',
    { preHandler: [auth, genRead] },
    async (_request, reply) => {
      return reply.code(200).send({ formats: CONTENT_FORMATS, meta: FORMAT_META });
    },
  );
}
