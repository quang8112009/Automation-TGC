/**
 * ServiceAccountService — non-interactive internal identities (Foundation Req 8).
 *
 * Provides credential-based authentication and permission checks for the
 * 'ai-system' and 'background-worker' service accounts, plus idempotent seeding.
 * Plaintext credentials are NEVER stored or logged (Req 8.6, 13.4): only the
 * argon2id hash is persisted and only account NAMES are ever logged.
 */
import { randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { Action, Module } from './rbac';
import { hashPassword, verifyPassword } from './password';
import type { SecretLoader } from '../infra/secrets';
import { createLogger } from '../infra/logger';
import { ForbiddenError, UnauthorizedError } from '../infra/errors';

export interface ServicePermissionEntry {
  module: Module;
  action: Action;
}

export interface AuthenticatedServiceAccount {
  id: string;
  name: string;
  permissions: ServicePermissionEntry[];
}

interface ServiceAccountSeed {
  name: string;
  /** Secret_Store key holding the plaintext credential (optional). */
  secretName: string;
  permissions: ServicePermissionEntry[];
}

/**
 * Declarative seed definitions. Keep permission sets aligned with the modules
 * each internal identity must reach (Req 8.x).
 */
const SEED_DEFINITIONS: readonly ServiceAccountSeed[] = [
  {
    name: 'ai-system',
    secretName: 'SERVICE_ACCOUNT_AI_SYSTEM_SECRET',
    permissions: [
      { module: 'generation', action: 'create' },
      { module: 'strategy', action: 'read' },
    ],
  },
  {
    name: 'background-worker',
    secretName: 'SERVICE_ACCOUNT_BACKGROUND_WORKER_SECRET',
    permissions: [
      { module: 'analytics', action: 'read' },
      { module: 'analytics', action: 'create' },
      { module: 'feedback', action: 'create' },
      { module: 'publishing', action: 'status_update' },
    ],
  },
];

export class ServiceAccountService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Authenticate a service account by name + credential. Throws UnauthorizedError (401)
   * when the account is missing, inactive, or the credential does not verify.
   */
  async authenticate(name: string, credential: string): Promise<AuthenticatedServiceAccount> {
    const account = await this.prisma.serviceAccount.findUnique({
      where: { name },
      include: { permissions: true },
    });
    if (!account || !account.active) {
      throw new UnauthorizedError('Invalid service credentials');
    }
    const ok = await verifyPassword(account.credentialHash, credential);
    if (!ok) {
      throw new UnauthorizedError('Invalid service credentials');
    }
    return {
      id: account.id,
      name: account.name,
      permissions: account.permissions.map((p) => ({
        module: p.module as Module,
        action: p.action as Action,
      })),
    };
  }

  /**
   * True iff an active service account with this name holds a matching permission row.
   */
  async hasPermission(name: string, module: Module, action: Action): Promise<boolean> {
    const account = await this.prisma.serviceAccount.findFirst({
      where: {
        name,
        active: true,
        permissions: { some: { module, action } },
      },
      select: { id: true },
    });
    return account !== null;
  }

  /** Throws ForbiddenError (403) when the service account lacks the permission. */
  async assertPermission(name: string, module: Module, action: Action): Promise<void> {
    const permitted = await this.hasPermission(name, module, action);
    if (!permitted) {
      throw new ForbiddenError('Service account lacks required permission');
    }
  }

  /**
   * Idempotently create the seeded service accounts and their permission sets.
   * Credentials are read from the Secret_Store; when absent a cryptographically
   * random credential is generated. Only the account NAME is ever logged.
   */
  async ensureSeeded(secrets: SecretLoader): Promise<void> {
    const logger = createLogger(secrets.redact);
    for (const seed of SEED_DEFINITIONS) {
      await this.seedOne(seed, secrets, logger);
    }
  }

  private async seedOne(
    seed: ServiceAccountSeed,
    secrets: SecretLoader,
    logger: ReturnType<typeof createLogger>,
  ): Promise<void> {
    const existing = await this.prisma.serviceAccount.findUnique({
      where: { name: seed.name },
      select: { id: true },
    });

    let accountId: string;
    if (existing) {
      accountId = existing.id;
      logger.info(`Service account "${seed.name}" already present; ensuring permissions`);
    } else {
      // Only hash when actually creating, to keep seeding idempotent and cheap.
      const plaintext = secrets.optional(seed.secretName) ?? randomBytes(32).toString('hex');
      const credentialHash = await hashPassword(plaintext);
      const created = await this.prisma.serviceAccount.upsert({
        where: { name: seed.name },
        update: {},
        create: { name: seed.name, credentialHash, active: true },
        select: { id: true },
      });
      accountId = created.id;
      logger.info(`Seeded service account "${seed.name}"`);
    }

    for (const perm of seed.permissions) {
      await this.prisma.servicePermission.upsert({
        where: {
          serviceAccountId_module_action: {
            serviceAccountId: accountId,
            module: perm.module,
            action: perm.action,
          },
        },
        update: {},
        create: {
          serviceAccountId: accountId,
          module: perm.module,
          action: perm.action,
        },
      });
    }
  }
}
