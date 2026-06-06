import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

/**
 * Apply an explicit connection-pool size to the DATABASE_URL when
 * `DB_CONNECTION_LIMIT` is set. Prisma only reads the pool size from the URL
 * (`?connection_limit=`), and since the API and worker now run as SEPARATE
 * processes the TOTAL connections to Postgres are (api + worker) × limit — so a
 * sane per-process cap protects Postgres `max_connections` on the single VM.
 *
 * Pure + exported for testing. Leaves the URL untouched when no limit is set or
 * one is already present; preserves any existing query string.
 */
export function applyConnectionLimit(url: string | undefined, limit: string | undefined): string | undefined {
  if (!url) return url;
  const n = Number((limit ?? '').trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return url;
  if (/[?&]connection_limit=/.test(url)) return url; // already specified
  return url.includes('?') ? `${url}&connection_limit=${n}` : `${url}?connection_limit=${n}`;
}

export function getPrisma(): PrismaClient {
  if (!client) {
    const url = applyConnectionLimit(
      process.env.DATABASE_URL,
      process.env.DB_CONNECTION_LIMIT,
    );
    client = url
      ? new PrismaClient({ datasources: { db: { url } } })
      : new PrismaClient();
  }
  return client;
}
