/**
 * validation — Zod-based input validation for all API request surfaces.
 *
 * SECURITY: Every user-controlled input passes through a Zod schema before
 * reaching business logic. This prevents injection, type confusion, oversized
 * inputs, and unexpected field presence. Validation runs BEFORE any DB query
 * or AI call, so a malformed request never reaches downstream systems.
 *
 * DESIGN:
 *   - Schemas are co-located with their route (not global) so each route
 *     declares its own contract. This file provides SHARED base schemas
 *     and validation helpers.
 *   - `validateBody`, `validateQuery`, `validateParams` are Fastify-compatible
 *     preHandler hooks that parse + narrow the request, attaching the typed
 *     result to `request.validatedBody` / `request.validatedQuery` / etc.
 *   - On validation failure, returns 400 with the first error message (no
 *     internal schema details leaked).
 *
 * SECURITY INVARIANTS:
 *   - String fields are TRIMMED and length-capped (prevents DoS via huge payloads).
 *   - Unknown fields are STRIPPED (prevents mass-assignment / parameter pollution).
 *   - Numeric fields are bounds-checked (prevents overflow / negative values).
 *   - Email/URL fields use built-in Zod format validators.
 *   - Enum fields are closed (only known values accepted).
 */
import { z } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ValidationError } from '../infra/errors';

// ── Shared base schemas ─────────────────────────────────────────────────────

/** Non-empty trimmed string (max 500 chars by default). */
export const TrimmedString = (maxLen = 500) =>
  z.string().trim().min(1).max(maxLen);

/** Optional trimmed string (max 500 chars; undefined/empty → undefined). */
export const OptionalString = (maxLen = 500) =>
  z.string().trim().max(maxLen).optional().or(z.literal('')).transform((v) => v || undefined);

/** Non-negative integer with bounds. */
export const PositiveInt = (min = 1, max = 10_000) =>
  z.number().int().min(min).max(max);

/** Non-negative float. */
export const NonNegativeFloat = (min = 0, max = 1_000_000) =>
  z.number().min(min).max(max);

/** UUID v4 format. */
export const UUID = z.string().uuid();

/** ISO datetime string. */
export const ISODateTime = z.string().datetime({ offset: true }).or(z.string().date());

/** Email address. */
export const Email = z.string().trim().email().max(254);

/** Pagination query params. */
export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['asc', 'desc']).default('desc'),
});

/** Asset kind enum (mirrors assetKinds.ts). */
export const AssetKindEnum = z.enum(['thumbnail', 'infographic', 'poster', 'short_video', 'image']);

/** Content format enum. */
export const ContentFormatEnum = z.enum([
  'GENERIC', 'SEO_ARTICLE', 'FANPAGE_CAPTION', 'VIDEO_SCRIPT',
  'EMAIL', 'CARE_MESSAGE', 'CHATBOT_FAQ',
]);

/** Market enum. */
export const MarketEnum = z.enum([
  'JAPAN', 'KOREA', 'GERMANY', 'TAIWAN', 'AUSTRALIA',
  'LITHUANIA', 'EUROPE', 'DOMESTIC', 'OTHER',
]);

// ── Asset schemas ───────────────────────────────────────────────────────────

/** Asset copy (text inputs for render spec slots). */
export const AssetCopySchema = z.object({
  title: TrimmedString(200),
  body: z.string().trim().max(2000).default(''),
  ctas: z.array(z.string().trim().max(100).min(1)).max(5).default([]),
  market: MarketEnum.optional(),
});

/** Single batch render item. */
export const BatchRenderItemSchema = z.object({
  kind: AssetKindEnum,
  title: TrimmedString(200),
  body: z.string().trim().max(2000).default(''),
  ctas: z.array(z.string().trim().max(100).min(1)).max(5).default([]),
  market: MarketEnum.optional(),
  draftId: UUID.optional(),
  templateId: UUID.optional(),
});

/** Batch render request body. */
export const BatchRenderBodySchema = z.object({
  items: z.array(BatchRenderItemSchema).min(1).max(20),
  concurrency: z.number().int().min(1).max(10).default(4),
});

/** Standalone asset generation body. */
export const StandaloneAssetBodySchema = z.object({
  kind: AssetKindEnum,
  title: TrimmedString(200),
  body: z.string().trim().max(2000).default(''),
  ctas: z.array(z.string().trim().max(100).min(1)).max(5).default([]),
  market: MarketEnum.optional(),
  templateId: UUID.optional(),
});

/** Draft-based asset generation body. */
export const DraftAssetBodySchema = z.object({
  draftId: UUID,
  kind: AssetKindEnum,
  templateId: UUID.optional(),
});

// ── Brand template schemas ──────────────────────────────────────────────────

/** Brand template creation body. */
export const BrandTemplateBodySchema = z.object({
  name: TrimmedString(100),
  kind: TrimmedString(50),
  spec: z.unknown(),
  active: z.boolean().optional(),
});

// ── Content generation schemas ──────────────────────────────────────────────

/** Multi-format generation request body. */
export const MultiFormatBodySchema = z.object({
  format: ContentFormatEnum,
  domainName: TrimmedString(100),
  personaIds: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
  objective: z.enum(['Lead', 'View', 'Follow']),
  market: MarketEnum.optional(),
  topic: OptionalString(200),
  keyword: OptionalString(100),
  planItemId: UUID.optional(),
});

// ── Auth schemas ────────────────────────────────────────────────────────────

/** Login body. */
export const LoginBodySchema = z.object({
  email: Email,
  password: z.string().min(1).max(128),
});

/** Register body. */
export const RegisterBodySchema = z.object({
  email: Email,
  password: z.string().min(8).max(128),
  name: TrimmedString(100),
});

// ── Validation middleware ────────────────────────────────────────────────────

/**
 * Create a Fastify preHandler that validates request.body against a Zod schema.
 * On success, attaches the parsed result to `request.validatedBody`.
 * On failure, throws ValidationError(400) with the first error message.
 */
export function validateBody<T extends z.ZodType>(schema: T) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      const firstError = result.error.errors[0];
      const message = firstError
        ? `${firstError.path.join('.')}: ${firstError.message}`
        : 'Invalid request body';
      throw new ValidationError(message, 'VALIDATION_ERROR');
    }
    (request as unknown as Record<string, unknown>).validatedBody = result.data;
  };
}

/**
 * Create a Fastify preHandler that validates request.query against a Zod schema.
 * On success, attaches the parsed result to `request.validatedQuery`.
 */
export function validateQuery<T extends z.ZodType>(schema: T) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.query);
    if (!result.success) {
      const firstError = result.error.errors[0];
      const message = firstError
        ? `${firstError.path.join('.')}: ${firstError.message}`
        : 'Invalid query parameters';
      throw new ValidationError(message, 'VALIDATION_ERROR');
    }
    (request as unknown as Record<string, unknown>).validatedQuery = result.data;
  };
}

/**
 * Create a Fastify preHandler that validates request.params against a Zod schema.
 * On success, attaches the parsed result to `request.validatedParams`.
 */
export function validateParams<T extends z.ZodType>(schema: T) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.params);
    if (!result.success) {
      const firstError = result.error.errors[0];
      const message = firstError
        ? `${firstError.path.join('.')}: ${firstError.message}`
        : 'Invalid path parameters';
      throw new ValidationError(message, 'VALIDATION_ERROR');
    }
    (request as unknown as Record<string, unknown>).validatedParams = result.data;
  };
}

/**
 * Sanitize a string for safe display (strip control characters, limit length).
 * Use for logging, error messages, and user-facing output.
 */
export function sanitizeDisplay(input: unknown, maxLen = 200): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip control chars
    .trim()
    .slice(0, maxLen);
}

/**
 * Rate-limit key extraction: derive a stable rate-limit key from a request.
 * Prefers the authenticated user ID; falls back to IP.
 */
export function rateLimitKey(request: FastifyRequest): string {
  const auth = (request as unknown as Record<string, unknown>).auth as
    | { userId?: string }
    | undefined;
  if (auth?.userId) return `user:${auth.userId}`;
  return `ip:${request.ip}`;
}
