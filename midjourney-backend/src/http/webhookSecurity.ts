/**
 * webhookSecurity — HMAC signature validation for inbound webhooks.
 *
 * SECURITY: Every webhook MUST be verified before processing. The shared
 * HMAC secret is loaded from the SecretLoader (never hardcoded). Verification
 * fails CLOSED — when a secret is empty/unset, ALL requests are rejected (401)
 * rather than accepting unsigned payloads.
 *
 * SUPPORTED SIGNATURE FORMATS:
 *   - Facebook: X-Hub-Signature-256 header = "sha256=<hex>"
 *   - Zalo OA:  X-Zalo-Signature header = "<hex>"
 *   - Generic:  X-Signature-256 header = "sha256=<hex>" (standard HMAC-SHA256)
 *
 * USAGE:
 *   app.post('/webhook/facebook', {
 *     preHandler: [verifyWebhook('FACEBOOK')]
 *   }, handler);
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../infra/errors';
import type { SecretLoader } from '../infra/secrets';

/** Supported webhook channels. */
export type WebhookChannel = 'FACEBOOK' | 'ZALO' | 'WEBSITE' | 'GENERIC';

/** Channel → header name + secret env key mapping. */
const WEBHOOK_CONFIG: Record<WebhookChannel, { header: string; secretKey: string }> = {
  FACEBOOK: { header: 'x-hub-signature-256', secretKey: 'WEBHOOK_SECRET_FACEBOOK' },
  ZALO: { header: 'x-zalo-signature', secretKey: 'WEBHOOK_SECRET_ZALO' },
  WEBSITE: { header: 'x-signature-256', secretKey: 'WEBHOOK_SECRET_WEBSITE' },
  GENERIC: { header: 'x-signature-256', secretKey: 'WEBHOOK_SECRET_GENERIC' },
};

/**
 * Compute HMAC-SHA256 of a payload buffer, returning the hex digest.
 */
export function computeHmac(payload: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Constant-time comparison of two strings (prevents timing attacks).
 * Returns true only if the strings are byte-identical.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract the raw request body as a Buffer.
 * Fastify stores the parsed body on request.body; for webhook verification
 * we need the RAW bytes. We read them from the rawBody decorator if available,
 * otherwise re-serialize.
 */
function extractRawBody(request: FastifyRequest): Buffer {
  // Fastify rawBody decorator (set when bodyLimit rawParsing is enabled).
  const rawBody = (request as unknown as Record<string, unknown>).rawBody;
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');

  // Fallback: serialize the parsed body (works for JSON payloads).
  const body = request.body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body), 'utf8');
}

/**
 * Verify the webhook signature for a given channel.
 * Throws AppError(401) on any failure:
 *   - WEBHOOK_SECRET_NOT_CONFIGURED: secret is empty/missing → reject ALL.
 *   - WEBHOOK_SIGNATURE_INVALID: signature mismatch → reject this request.
 *   - WEBHOOK_MISSING_HEADER: required header is absent.
 */
export function verifyWebhookSignature(
  request: FastifyRequest,
  channel: WebhookChannel,
  secrets: SecretLoader,
): void {
  const config = WEBHOOK_CONFIG[channel];
  if (!config) {
    throw new AppError(401, `Unknown webhook channel: ${channel}`, 'WEBHOOK_UNKNOWN_CHANNEL');
  }

  const secret = secrets.optional(config.secretKey);

  // FAIL CLOSED: no secret configured → reject ALL requests for this channel.
  if (!secret || secret.trim().length === 0) {
    throw new AppError(
      401,
      `Webhook secret not configured for ${channel} — all requests rejected`,
      'WEBHOOK_SECRET_NOT_CONFIGURED',
    );
  }

  // Extract the signature header.
  const signatureHeader = request.headers[config.header];
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    throw new AppError(
      401,
      `Missing webhook signature header: ${config.header}`,
      'WEBHOOK_MISSING_HEADER',
    );
  }

  // Compute expected signature.
  const rawBody = extractRawBody(request);
  const expectedHex = computeHmac(rawBody, secret);

  // For Facebook, the header is "sha256=<hex>".
  let receivedHex = signatureHeader;
  if (signatureHeader.startsWith('sha256=')) {
    receivedHex = signatureHeader.slice(7);
  }

  // Constant-time comparison (prevents timing attacks).
  if (!timingSafeCompare(expectedHex, receivedHex)) {
    throw new AppError(401, 'Webhook signature mismatch', 'WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * Create a Fastify preHandler that verifies the webhook signature.
 * Usage:
 *   app.post('/webhook/fb', { preHandler: [verifyWebhook('FACEBOOK', secrets)] }, handler);
 */
export function verifyWebhook(channel: WebhookChannel, secrets: SecretLoader) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    verifyWebhookSignature(request, channel, secrets);
  };
}
