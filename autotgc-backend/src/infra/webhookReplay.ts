/**
 * Webhook replay protection (security hardening).
 *
 * HMAC verification proves a payload was signed with the shared secret, but it
 * does NOT prevent an attacker (or a flaky platform) from REPLAYING a captured,
 * still-valid signed delivery. This module closes that gap with a persisted
 * replay ledger: the first time a (source, deliveryId) pair is seen it is
 * recorded and accepted; any subsequent delivery of the same pair is rejected.
 *
 * `deliveryId` is, in order of preference, a provider-supplied delivery/event id
 * (passed by the caller) or a SHA-256 fingerprint of the raw body. Because real
 * platform payloads embed per-event ids + timestamps, the body fingerprint is a
 * strong nonce in practice.
 *
 * The ledger write races safely: the unique (source, deliveryId) index means a
 * concurrent duplicate fails the insert, which we treat as a replay.
 */
import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';

/** A canonical fingerprint for the raw body, used when no provider id exists. */
export function fingerprintBody(rawBody: Buffer | string): string {
  const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHash('sha256').update(buf).digest('hex');
}

/** A short, non-secret signature fingerprint stored for forensics only. */
function signatureFingerprint(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  // Hash the signature so we never persist a reusable token; keep it short.
  return createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

export interface ReplayCheckInput {
  /** Logical webhook source, e.g. 'lead:facebook' | 'intake:zalo'. */
  source: string;
  /** Provider delivery/event id when available; otherwise omit to hash the body. */
  deliveryId?: string;
  /** Raw request body (used to derive the fingerprint when no deliveryId). */
  rawBody: Buffer | string;
  /** The verified signature header (only a hash fragment is stored). */
  signature?: string;
}

/**
 * Record a delivery and report whether it is a first-time (fresh) delivery.
 * Returns `true` when the delivery is NEW (proceed), `false` when it is a replay
 * (reject with 409). Never throws on a duplicate; storage errors are surfaced.
 */
export async function recordWebhookDelivery(
  prisma: PrismaClient,
  input: ReplayCheckInput,
): Promise<boolean> {
  const deliveryId = input.deliveryId && input.deliveryId.length > 0
    ? input.deliveryId
    : fingerprintBody(input.rawBody);

  try {
    await prisma.webhookDelivery.create({
      data: {
        source: input.source,
        deliveryId,
        signature: signatureFingerprint(input.signature),
      },
    });
    return true;
  } catch (err) {
    // Prisma P2002 = unique constraint violation => this exact delivery was
    // already accepted => replay.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** True for a Prisma unique-constraint (P2002) error, without importing runtime types. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
