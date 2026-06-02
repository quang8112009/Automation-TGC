/**
 * Webhook HMAC signature verification (Foundation Req 20).
 * Constant-time compare; verification before body processing.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export function computeSignature(secret: string, rawBody: Buffer | string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(secret: string, rawBody: Buffer | string, signatureHeader: string): boolean {
  // Fail closed: an empty/absent secret must NEVER verify. Otherwise an
  // unconfigured webhook secret (default '') would let an attacker forge a
  // valid HMAC by signing with the empty key. A webhook with no configured
  // secret is therefore always rejected rather than silently trusted.
  if (!secret) return false;
  if (!signatureHeader) return false;
  const expected = computeSignature(secret, rawBody);
  // Normalize a possible "sha256=" prefix used by some platforms.
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
