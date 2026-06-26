/**
 * Fastify authentication & authorization preHandlers.
 * - requireAuth: Bearer token -> JwtService.verify(access) -> JwtSession ACTIVE check -> attach auth.
 * - requireRole: coarse role gate.
 * - rbacGuard: fine-grained policy via authorize() with a per-request ResourceTarget builder.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService, Role } from '../auth/jwt';
import { authorize } from '../auth/rbac';
import type { Action, AuthContext, Module, ResourceTarget } from '../auth/rbac';
import { ForbiddenError, UnauthorizedError } from '../infra/errors';
import { REALTIME_PUBLIC_PATHS } from '../realtime';
import { API_INFO_PUBLIC_PATHS } from './apiInfo';
import { INTAKE_PUBLIC_PATHS } from '../intake/publicPaths';

export interface AuthInfo {
  userId: string;
  role: Role;
  sessionId: string;
}

// Augment Fastify request with the authenticated principal.
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}

export interface AuthDeps {
  prisma: PrismaClient;
  jwt: JwtService;
}

/** Public routes that must NOT pass through auth. */
export const PUBLIC_PATHS: readonly string[] = [
  '/healthz',
  '/readyz',
  '/docs',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/refresh',
  // Logout authenticates itself: it accepts a valid access token OR a refresh
  // token in the body, so it must bypass the global gate (a client whose access
  // token has expired must still be able to revoke its session via the refresh
  // token). The handler verifies whichever token is supplied.
  '/api/auth/logout',
  '/api/leads/webhook/facebook',
  '/api/leads/webhook/website',
  // Omni-channel chatbot intake webhooks (Facebook Messenger + Zalo OA). They
  // verify a per-channel HMAC signature inside the handler before processing.
  ...INTAKE_PUBLIC_PATHS,
  // Real-time transports authenticate via a query-string token, so they bypass
  // the global JWT preHandler and perform their own verification.
  ...REALTIME_PUBLIC_PATHS,
  // Public API manifest / gateway info.
  ...API_INFO_PUBLIC_PATHS,
];

function extractBearer(header: string | undefined): string {
  if (!header) throw new UnauthorizedError('Missing Authorization header');
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || token.trim().length === 0) {
    throw new UnauthorizedError('Malformed Authorization header');
  }
  return token.trim();
}

/**
 * preHandler that authenticates the request. On any failure it throws UnauthorizedError,
 * which the global error handler converts to a 401 envelope.
 */
export function requireAuth(deps: AuthDeps): preHandlerHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    const token = extractBearer(request.headers.authorization);

    let claims;
    try {
      claims = await deps.jwt.verify(token, 'access');
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    const session = await deps.prisma.jwtSession.findUnique({
      where: { sessionId: claims.sid },
    });
    if (!session || session.status !== 'ACTIVE' || session.revokedAt !== null) {
      throw new UnauthorizedError('Session is not active');
    }

    request.auth = {
      userId: claims.sub,
      role: claims.role,
      sessionId: claims.sid,
    };
  };
}

/** Read the authenticated principal or throw (defensive; requireAuth should run first). */
export function getAuth(request: FastifyRequest): AuthInfo {
  if (!request.auth) {
    throw new UnauthorizedError('Authentication required');
  }
  return request.auth;
}

/** Coarse role gate: allow only the listed roles. */
export function requireRole(...roles: Role[]): preHandlerHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = getAuth(request);
    if (!roles.includes(auth.role)) {
      throw new ForbiddenError();
    }
  };
}

/**
 * Fine-grained RBAC gate. The builder may inspect the request (params/body) and may be async
 * (e.g. to resolve a lead's owner). Returning undefined denies with 403.
 */
export type TargetBuilder = (
  request: FastifyRequest,
  reply: FastifyReply,
) => ResourceTarget | undefined | Promise<ResourceTarget | undefined>;

/**
 * Best-effort audit sink for denied authorization decisions (Req 7.2, 7.3).
 * Implementations MUST be fire-and-forget: swallow their own errors and never
 * block or fail the response. Kept out of `auth/rbac.ts` so policy evaluation
 * stays pure; injected at `app.ts` from an auditor wrapping ActivityLogger.
 */
export interface RbacAuditor {
  recordDenied(input: {
    actorUserId: string;
    module: Module;
    action: Action;
    targetId?: string;
  }): void;
}

export function rbacGuard(build: TargetBuilder, auditor?: RbacAuditor): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = getAuth(request);
    const target = await build(request, reply);
    if (!target) {
      // No resolvable target (e.g. unassigned / not-found owner) → fail-closed 403.
      // We have no module/action here, so use a safe lead_management/read fallback.
      auditor?.recordDenied({ actorUserId: auth.userId, module: 'lead_management', action: 'read' });
      throw new ForbiddenError();
    }
    const ctx: AuthContext = { userId: auth.userId, role: auth.role };
    const decision = authorize(ctx, target);
    if (!decision.allowed) {
      auditor?.recordDenied({
        actorUserId: auth.userId,
        module: target.module,
        action: target.action,
        targetId: target.ownerUserId,
      });
      throw new ForbiddenError();
    }
  };
}

/**
 * Decide whether a request URL is in the public allow-list (no global auth).
 *
 * Pure & exported for property/unit testing. Matching rules:
 *  - The query string is stripped first (`/docs?foo=1` → `/docs`).
 *  - `/docs` matches itself AND any sub-path (`/docs`, `/docs/`, `/docs/json`,
 *    `/docs/static/...`) because @fastify/swagger-ui serves its assets under
 *    that prefix.
 *  - Every other allow-listed path matches EXACTLY (a trailing-slash variant is
 *    also accepted), so a public prefix can never accidentally expose a
 *    protected sibling route.
 */
export function isPublicPath(rawUrl: string, publicPaths: readonly string[] = PUBLIC_PATHS): boolean {
  const path = (rawUrl.split('?')[0] ?? rawUrl).replace(/\/+$/, '') || '/';
  for (const p of publicPaths) {
    const normalized = p.replace(/\/+$/, '') || '/';
    if (path === normalized) return true;
    // Prefix-match ONLY for the docs UI, whose assets live under /docs/*.
    if (normalized === '/docs' && path.startsWith('/docs/')) return true;
  }
  return false;
}

/**
 * Register a SINGLE global authentication gate (deny-by-default).
 *
 * Historically each route registrar had to remember to attach `requireAuth` /
 * `rbacGuard`; a single omission silently exposed a route. This `onRequest` hook
 * closes that gap: every request that is NOT in {@link PUBLIC_PATHS} must carry a
 * valid access token tied to an ACTIVE session, or it is rejected with 401
 * before reaching any handler.
 *
 * It runs in the `onRequest` phase (before body parsing) and sets `request.auth`
 * so per-route `requireAuth` (which remains for explicit clarity) is idempotent,
 * and `rbacGuard` builders can read the principal. Public routes that do their
 * own auth (webhooks via HMAC, realtime via query-token) stay in the allow-list.
 */
export function registerGlobalAuthGate(app: FastifyInstance, deps: AuthDeps): void {
  app.addHook('onRequest', async (request: FastifyRequest): Promise<void> => {
    if (isPublicPath(request.url)) return;
    // Inline the same checks as requireAuth so token + session verification stays
    // in one place (the onRequest signature differs from a preHandler).
    const token = extractBearer(request.headers.authorization);
    let claims;
    try {
      claims = await deps.jwt.verify(token, 'access');
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
    const session = await deps.prisma.jwtSession.findUnique({
      where: { sessionId: claims.sid },
    });
    if (!session || session.status !== 'ACTIVE' || session.revokedAt !== null) {
      throw new UnauthorizedError('Session is not active');
    }
    request.auth = { userId: claims.sub, role: claims.role, sessionId: claims.sid };
  });
}
