/**
 * Platform-token HTTP routes (Foundation Req 10.3, 11.5).
 *
 * Registered separately from routes/index.ts so this Foundation slice stays
 * self-contained. Both routes sit behind requireAuth + rbacGuard for the
 * 'settings' module. The list endpoint returns only the secret-free public view.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../infra/config';
import type { JwtService } from '../auth/jwt';
import { getAuth, rbacGuard, requireAuth } from '../http/authMiddleware';
import type { TokenManager } from '../tokens/tokenManager';

export interface PlatformTokenRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  config: AppConfig;
  tokenManager: TokenManager;
}

interface PlatformParams {
  platform: string;
}

export function registerPlatformTokenRoutes(
  app: FastifyInstance,
  deps: PlatformTokenRouteDeps,
): void {
  const { prisma, jwt, tokenManager } = deps;
  const auth = requireAuth({ prisma, jwt });

  app.get(
    '/api/platform-tokens',
    {
      preHandler: [auth, rbacGuard(() => ({ module: 'settings', action: 'read' }))],
    },
    async (request, reply) => {
      // getAuth asserts an authenticated principal is present (defensive).
      getAuth(request);
      const tokens = await tokenManager.listPublic();
      return reply.code(200).send({ tokens });
    },
  );

  app.post(
    '/api/platform-tokens/:platform/refresh',
    {
      preHandler: [auth, rbacGuard(() => ({ module: 'settings', action: 'update' }))],
    },
    async (request, reply) => {
      getAuth(request);
      const { platform } = request.params as PlatformParams;
      const view = await tokenManager.refresh(platform);
      return reply.code(200).send(view);
    },
  );
}
