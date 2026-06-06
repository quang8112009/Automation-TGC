/**
 * Platform-token HTTP routes (Foundation Req 10.3, 11.5).
 *
 * Registered separately from routes/index.ts so this Foundation slice stays
 * self-contained. Both routes sit behind requireAuth + rbacGuard for the
 * 'platform_tokens' module (a fine-grained surface SALES may manage without the
 * privilege escalation that flattening the shared `settings` module would cause
 * — sales-access-restrictions Req 1.1–1.3, 6). The list endpoint returns only
 * the secret-free public view.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../infra/config';
import type { JwtService } from '../auth/jwt';
import { getAuth, rbacGuard, requireAuth } from '../http/authMiddleware';
import type { TokenManager } from '../tokens/tokenManager';
import type { ActivityLogger } from '../oversight/activityLogger';

export interface PlatformTokenRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  config: AppConfig;
  tokenManager: TokenManager;
  /**
   * Optional audit sink. When present, a successful token refresh appends one
   * `PLATFORM_TOKEN_REFRESHED` ActivityLog entry (metadata only, never the
   * secret value — sales-access-restrictions Req 7.1, 7.4). Optional so existing
   * wiring that does not pass it keeps compiling and behaves exactly as before.
   */
  activityLogger?: ActivityLogger;
}

interface PlatformParams {
  platform: string;
}

export function registerPlatformTokenRoutes(
  app: FastifyInstance,
  deps: PlatformTokenRouteDeps,
): void {
  const { prisma, jwt, tokenManager, activityLogger } = deps;
  const auth = requireAuth({ prisma, jwt });

  app.get(
    '/api/platform-tokens',
    {
      preHandler: [auth, rbacGuard(() => ({ module: 'platform_tokens', action: 'read' }))],
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
      preHandler: [auth, rbacGuard(() => ({ module: 'platform_tokens', action: 'update' }))],
    },
    async (request, reply) => {
      const actor = getAuth(request);
      const { platform } = request.params as PlatformParams;
      const view = await tokenManager.refresh(platform);

      // Best-effort audit (Req 7.1). The detail carries metadata only — platform
      // name and computed validity/type/expiry — and NEVER the secret token
      // value (Req 7.4). A logging failure must not break the refresh response.
      if (activityLogger) {
        try {
          await activityLogger.append({
            actorUserId: actor.userId,
            action: 'PLATFORM_TOKEN_REFRESHED',
            targetType: 'platform_token',
            targetId: platform,
            detail: {
              platform: view.platform,
              type: view.type,
              valid: view.valid,
              expiresAt: view.expiresAt,
            },
          });
        } catch {
          // Swallow: audit is best-effort and never blocks the response.
        }
      }

      return reply.code(200).send(view);
    },
  );
}
