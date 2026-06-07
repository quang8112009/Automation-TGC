/**
 * UserManagementService — ADMIN-only staff account management.
 * list / create SALES / lock / unlock / changeRole / resetPassword.
 *
 * Pure I/O orchestration over Prisma; reuses argon2 hashing from password.ts
 * (plaintext is never persisted). Throws typed AppError subclasses from
 * infra/errors.ts so the route layer maps them onto the allowed status set.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8.
 */
import type { PrismaClient, UserAccount } from '@prisma/client';
import type { Role } from './jwt';
import { hashPassword } from './password';
import { ConflictError, NotFoundError, ValidationError } from '../infra/errors';

export interface ManagedUserView {
  id: string;
  username: string;
  email: string;
  role: Role;
  locked: boolean;
}

const VALID_ROLES: ReadonlySet<Role> = new Set<Role>(['ADMIN', 'SALES']);

function toManagedUserView(u: UserAccount): ManagedUserView {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role as Role,
    locked: u.locked,
  };
}

/** True only when the value is a non-blank (non-whitespace-only) string. */
function isNonBlank(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class UserManagementService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Req 5.1: list every account with username/email/role/locked. */
  async list(): Promise<ManagedUserView[]> {
    const users = await this.prisma.userAccount.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return users.map(toManagedUserView);
  }

  /**
   * Req 5.2/5.3/5.4: create a SALES account.
   * 400 if username/email/password are missing or blank; 409 if username taken.
   */
  async createSalesUser(input: {
    username?: string;
    email?: string;
    password?: string;
  }): Promise<ManagedUserView> {
    if (!isNonBlank(input.username)) {
      throw new ValidationError('A non-blank username is required.', 'INVALID_USERNAME');
    }
    if (!isNonBlank(input.email)) {
      throw new ValidationError('A non-blank email is required.', 'INVALID_EMAIL');
    }
    if (!isNonBlank(input.password)) {
      throw new ValidationError('A non-blank password is required.', 'INVALID_PASSWORD');
    }

    const username = input.username.trim();
    const existing = await this.prisma.userAccount.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictError('Username already exists', 'USERNAME_TAKEN');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.prisma.userAccount.create({
      data: {
        username,
        email: input.email,
        passwordHash,
        role: 'SALES',
      },
    });
    return toManagedUserView(user);
  }

  /**
   * Revoke every ACTIVE JWT session for a user so existing access/refresh tokens
   * stop working immediately. Without this, `requireAuth` keeps accepting a
   * still-valid token (up to the access TTL) and `/api/auth/refresh` keeps
   * minting new ones for the refresh TTL, defeating lock/role-change/password-
   * reset as incident-containment actions. Mirrors AuthService.logout's
   * status->REVOKED + revokedAt write, but across all of the user's sessions.
   */
  private async revokeActiveSessions(userId: string): Promise<void> {
    await this.prisma.jwtSession.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }

  /** Req 5.5: lock an account. 404 if not found. Also revokes active sessions. */
  async lock(userId: string): Promise<ManagedUserView> {
    await this.requireUser(userId);
    const user = await this.prisma.userAccount.update({
      where: { id: userId },
      data: { locked: true, lockedAt: new Date() },
    });
    // Locking must terminate the user's live tokens, not just block future logins.
    await this.revokeActiveSessions(userId);
    return toManagedUserView(user);
  }

  /** Req 5.6: unlock an account and reset failedLoginCount to 0. 404 if not found. */
  async unlock(userId: string): Promise<ManagedUserView> {
    await this.requireUser(userId);
    const user = await this.prisma.userAccount.update({
      where: { id: userId },
      data: { locked: false, lockedAt: null, lockedUntil: null, failedLoginCount: 0 },
    });
    return toManagedUserView(user);
  }

  /** Req 5.7: change role. Only {ADMIN, SALES} allowed (else 400). 404 if not found. */
  async changeRole(userId: string, role: Role): Promise<ManagedUserView> {
    if (!VALID_ROLES.has(role)) {
      throw new ValidationError('Role must be one of ADMIN or SALES.', 'INVALID_ROLE');
    }
    await this.requireUser(userId);
    const user = await this.prisma.userAccount.update({
      where: { id: userId },
      data: { role },
    });
    // A role change must not be carried by an old token whose `role` claim still
    // reflects the previous role; force re-login so the new role takes effect.
    await this.revokeActiveSessions(userId);
    return toManagedUserView(user);
  }

  /**
   * Req 5.8: reset password. Validates non-blank, stores an argon2 hash, and
   * never persists plaintext. 404 if not found. Also revokes active sessions so
   * a reset (often a compromise response) invalidates any tokens the previous
   * password's holder still has.
   */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    if (!isNonBlank(newPassword)) {
      throw new ValidationError('A non-blank password is required.', 'INVALID_PASSWORD');
    }
    await this.requireUser(userId);
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.userAccount.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await this.revokeActiveSessions(userId);
  }

  /** Throws NotFoundError (404) when the account does not exist. */
  private async requireUser(userId: string): Promise<UserAccount> {
    const user = await this.prisma.userAccount.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('User account not found', 'USER_NOT_FOUND');
    }
    return user;
  }
}
