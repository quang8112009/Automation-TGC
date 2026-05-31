/**
 * Process entrypoint: fail-fast secret/config loading, root guard, build + listen,
 * graceful shutdown. Secrets are never logged as values (redaction via logger).
 */
import { createSecretLoader, MissingSecretError } from './infra/secrets';
import { createLogger } from './infra/logger';
import { assertNotRoot, loadConfig } from './infra/config';
import { getPrisma } from './infra/prisma';
import { JwtService } from './auth/jwt';
import { buildApp } from './app';
import { composeServices } from './infra/services';
import { startScheduledJobs } from './infra/jobs';

async function main(): Promise<void> {
  const loader = createSecretLoader();
  const logger = createLogger(loader.redact);

  // Req 14.3: refuse to run as root.
  try {
    assertNotRoot();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  // Req 13.3: fail-fast on missing secrets, logging only the secret NAME.
  let config;
  try {
    config = loadConfig(loader);
  } catch (err) {
    if (err instanceof MissingSecretError) {
      logger.error(`Startup aborted: missing required secret "${err.secretName}"`);
    } else {
      logger.error(`Startup aborted: ${(err as Error).message}`);
    }
    process.exit(1);
    return;
  }

  const jwt = new JwtService(
    config.jwtSecret,
    config.accessTokenTtlHours,
    config.refreshTokenTtlDays,
  );
  const prisma = getPrisma();

  const services = composeServices(prisma, loader);
  const app = await buildApp(config, { prisma, jwt, redact: loader.redact, services, logger });

  // Seed internal service accounts (idempotent) before starting workers.
  try {
    const { ServiceAccountService } = await import('./auth/serviceAccountService');
    await new ServiceAccountService(prisma).ensureSeeded(loader);
    logger.info('Service accounts seeded');
  } catch (err) {
    logger.error(`Service-account seeding failed: ${(err as Error).message}`);
  }

  // Start BullMQ workers (publish + score) when Redis is configured.
  let stopWorkers: (() => Promise<void>) | undefined;
  try {
    const { startPublishWorker, startScoreWorker, closeWorkers } = await import('./queues/workers');
    startPublishWorker({
      redisUrl: config.redisUrl,
      prisma,
      registry: services.registry,
      tokenManager: services.tokenManager,
      alerts: services.alerts,
    });
    startScoreWorker({ redisUrl: config.redisUrl, prisma });
    stopWorkers = closeWorkers;
    logger.info('BullMQ workers started (publish, score)');
  } catch (err) {
    logger.error(`Failed to start queue workers: ${(err as Error).message}`);
  }

  // Start scheduled automation (token refresh 12h, analytics collection 6h,
  // publishing due-scan every minute, weekly feedback Sun 00:00). A failure to
  // start jobs is logged but must not block the API from serving.
  let scheduler: ReturnType<typeof startScheduledJobs> | undefined;
  try {
    scheduler = startScheduledJobs({
      prisma,
      secrets: loader,
      logger,
      registry: services.registry,
      tokenManager: services.tokenManager,
      alerts: services.alerts,
      redisUrl: config.redisUrl,
    });
  } catch (err) {
    logger.error(`Failed to start scheduled jobs: ${(err as Error).message}`);
  }

  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info(`AutoTGC backend started on ${config.host}:${config.port} (env=${config.nodeEnv})`);
  } catch (err) {
    logger.error(`Failed to start server: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      scheduler?.stop();
      if (stopWorkers) await stopWorkers();
      await app.close();
      await prisma.$disconnect();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error(`Error during shutdown: ${(err as Error).message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
