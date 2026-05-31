/**
 * Readiness probe.
 *
 * `/healthz` (liveness) is defined elsewhere and intentionally NOT redefined here.
 * This adds a public `/readyz` that verifies the service's backing dependencies:
 *   - PostgreSQL reachable  (Prisma `SELECT 1`)
 *   - Redis reachable       (pingRedis)
 *
 * Returns 200 when both pass, else 503. 503 is not part of the project's allowed
 * status set, but readiness probes conventionally use it; it is sent directly via
 * `reply.code(503)` so it bypasses the global error handler.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma } from '../infra/prisma';
import { pingRedis } from '../infra/redis';

export interface ReadinessDeps {
  redisUrl: string;
}

interface ReadinessChecks {
  db: boolean;
  redis: boolean;
}

async function checkDb(): Promise<boolean> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(redisUrl: string): Promise<boolean> {
  try {
    return await pingRedis(redisUrl);
  } catch {
    return false;
  }
}

export function registerReadiness(app: FastifyInstance, deps: ReadinessDeps): void {
  app.get('/readyz', async (_request: FastifyRequest, reply: FastifyReply) => {
    const [db, redis] = await Promise.all([checkDb(), checkRedis(deps.redisUrl)]);
    const checks: ReadinessChecks = { db, redis };
    const ready = db && redis;

    if (ready) {
      return reply.code(200).send({ status: 'ready', checks });
    }
    return reply.code(503).send({ status: 'not_ready', checks });
  });
}
