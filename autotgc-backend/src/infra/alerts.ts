/**
 * Token lifecycle alerting (Foundation Req 12.x).
 *
 * AlertDispatcher records token alerts that surface on the ADMIN Dashboard
 * notifications channel. The Prisma-backed implementation writes a TokenAlert
 * row; alternate implementations could additionally push to other channels.
 */
import type { PrismaClient } from '@prisma/client';

/** Kinds of token lifecycle alert (mirrors API_Catalog token lifecycle). */
export type AlertKind = 'EXPIRY' | 'PRE_EXPIRY_WARNING' | 'REFRESH_FAILURE';

export interface AlertDispatcher {
  raise(kind: AlertKind, platform: string, reason?: string): Promise<void>;
}

/**
 * Persists alerts as TokenAlert rows. The Dashboard reads these for the ADMIN
 * notifications feed. Never includes secret values in the reason.
 */
export class PrismaAlertDispatcher implements AlertDispatcher {
  constructor(private readonly prisma: PrismaClient) {}

  async raise(kind: AlertKind, platform: string, reason?: string): Promise<void> {
    await this.prisma.tokenAlert.create({
      data: { kind, platform, reason: reason ?? null },
    });
  }
}

/** In-memory dispatcher for tests; records raised alerts without a database. */
export class InMemoryAlertDispatcher implements AlertDispatcher {
  readonly alerts: Array<{ kind: AlertKind; platform: string; reason?: string }> = [];

  async raise(kind: AlertKind, platform: string, reason?: string): Promise<void> {
    this.alerts.push({ kind, platform, reason });
  }
}
