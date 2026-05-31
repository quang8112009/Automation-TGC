/**
 * Fastify preHandler for SERVICE ACCOUNT authentication (Foundation Req 8).
 *
 * Reads a credential from either:
 *   - the `x-service-credential` header (paired with a `name` bound at wiring time), or
 *   - `Authorization: ServiceAccount <name>:<credential>`.
 * Authenticates via ServiceAccountService, asserts the required permission, and
 * attaches `request.serviceAccount = { name }`. Failures throw Unauthorized/Forbidden,
 * which the global error handler maps to 401/403 envelopes.
 */
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Action, Module } from './rbac';
import { ServiceAccountService } from './serviceAccountService';
import { UnauthorizedError } from '../infra/errors';

// Augment Fastify request with the authenticated service principal.
declare module 'fastify' {
  interface FastifyRequest {
    serviceAccount?: { name: string };
  }
}

interface ParsedCredential {
  name: string;
  credential: string;
}

/**
 * Resolve the (name, credential) pair for this request.
 *
 * Preference order:
 *  1. `Authorization: ServiceAccount <name>:<credential>` — carries its own name.
 *  2. `x-service-credential: <credential>` — uses the route-bound `expectedName`.
 */
function parseCredential(request: FastifyRequest, expectedName: string): ParsedCredential {
  const authHeader = request.headers.authorization;
  if (authHeader) {
    const [scheme, ...rest] = authHeader.split(' ');
    if (scheme === 'ServiceAccount') {
      const token = rest.join(' ').trim();
      const sep = token.indexOf(':');
      if (sep <= 0 || sep === token.length - 1) {
        throw new UnauthorizedError('Malformed ServiceAccount authorization header');
      }
      const name = token.slice(0, sep).trim();
      const credential = token.slice(sep + 1).trim();
      if (!name || !credential) {
        throw new UnauthorizedError('Malformed ServiceAccount authorization header');
      }
      return { name, credential };
    }
  }

  const headerCredential = request.headers['x-service-credential'];
  const credential = Array.isArray(headerCredential) ? headerCredential[0] : headerCredential;
  if (credential && credential.trim().length > 0) {
    return { name: expectedName, credential: credential.trim() };
  }

  throw new UnauthorizedError('Missing service credential');
}

/**
 * Build a preHandler that authenticates the named service account and asserts the
 * given (module, action) permission. The route is bound to a specific `name`; an
 * Authorization-supplied name that does not match is rejected.
 */
export function requireServiceAccount(
  prisma: PrismaClient,
  name: string,
  module: Module,
  action: Action,
): preHandlerHookHandler {
  const service = new ServiceAccountService(prisma);
  return async (request: FastifyRequest): Promise<void> => {
    const parsed = parseCredential(request, name);
    if (parsed.name !== name) {
      throw new UnauthorizedError('Service account name mismatch');
    }
    const account = await service.authenticate(parsed.name, parsed.credential);
    await service.assertPermission(account.name, module, action);
    request.serviceAccount = { name: account.name };
  };
}
