/**
 * AuthService — registration, login (with lockout), refresh, logout.
 * Wires pure validation + password hashing + JwtService against Prisma.
 * Foundation Req 1, 2, 4.
 */
import type { PrismaClient, UserAccount } from '@prisma/client';
import type { JwtService, Role, TokenPair } from './jwt';
import { hashPassword, verifyPassword } from './password';
import { validateLoginShape, validateRegistration } from './validation';
import type { RegisterInput } from './validation';
import {
  ConflictError,
  ForbiddenError,
  LockedError,
  UnauthorizedError,
  ValidationError,
} from '../infra/errors';

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: Role;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

function toPublicUser(u: UserAccount): PublicUser {
  return { id: u.id, username: u.username, email: u.email, role: u.role as Role };
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
    private readonly lockoutThreshold: number,
    private readonly accessTtlHours = 24,
    private readonly refreshTtlDays = 30,
    /** Auto-recovery window (minutes) for a locked account. 0 disables auto-unlock. */
    private readonly lockoutCooldownMinutes = 15,
  ) {}

  private expiries(now: Date): { accessExpiresAt: Date; refreshExpiresAt: Date } {
    return {
      accessExpiresAt: new Date(now.getTime() + this.accessTtlHours * 3600 * 1000),
      refreshExpiresAt: new Date(now.getTime() + this.refreshTtlDays * 86400 * 1000),
    };
  }

  private async createSession(userId: string): Promise<string> {
    const now = new Date();
    const { accessExpiresAt, refreshExpiresAt } = this.expiries(now);
    const session = await this.prisma.jwtSession.create({
      data: { userId, status: 'ACTIVE', accessExpiresAt, refreshExpiresAt },
    });
    return session.sessionId;
  }

  async register(input: RegisterInput): Promise<AuthResult> {
    const validation = validateRegistration(input);
    if (!validation.ok) {
      throw new ValidationError(validation.message, validation.code);
    }

    // Bootstrap-only public registration (privilege-escalation guard).
    //
    // This endpoint creates an ADMIN, so leaving it open to the public would let
    // any anonymous caller mint a full-access admin account. We therefore allow
    // it ONLY to bootstrap the very first account on an empty system. Once any
    // account exists, public registration is closed and further accounts must be
    // created by an ADMIN via the user-management API (which only mints SALES).
    const accountCount = await this.prisma.userAccount.count();
    if (accountCount > 0) {
      throw new ForbiddenError(
        'Public registration is closed. Ask an administrator to create your account.',
        'REGISTRATION_CLOSED',
      );
    }

    const username = (input.username ?? '').trim();
    const existing = await this.prisma.userAccount.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictError('Username already exists', 'USERNAME_TAKEN');
    }

    const passwordHash = await hashPassword(input.password ?? '');
    const user = await this.prisma.userAccount.create({
      data: {
        username,
        email: input.email ?? '',
        passwordHash,
        role: 'ADMIN',
      },
    });

    const sessionId = await this.createSession(user.id);
    const tokens = await this.jwt.issuePair(user.id, user.role as Role, sessionId);
    return { user: toPublicUser(user), tokens };
  }

  async login(username?: string, password?: string): Promise<AuthResult> {
    const validation = validateLoginShape({ username, password });
    if (!validation.ok) {
      throw new ValidationError(validation.message, validation.code);
    }

    const user = await this.prisma.userAccount.findUnique({
      where: { username: username as string },
    });
    // Unknown user: 401, no counter to change.
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Locked account handling with TIME-BOXED auto-recovery (security).
    //
    // A purely permanent lock means a credential-stuffing burst can permanently
    // DoS any account — including the only ADMIN, who would then have no way back
    // in (login is the only public entry; unlock is itself ADMIN-only). So a lock
    // set by the failed-login threshold carries an expiry (`lockedUntil`): once it
    // passes, the next attempt auto-clears the lock and proceeds to normal
    // password verification. A lock WITHOUT an expiry (lockedUntil = null, e.g. a
    // manual ADMIN lock or a legacy row) stays locked until an ADMIN unlocks it.
    if (user.locked) {
      const now = new Date();
      const canAutoRecover =
        this.lockoutCooldownMinutes > 0 &&
        user.lockedUntil !== null &&
        user.lockedUntil <= now;
      if (!canAutoRecover) {
        throw new LockedError();
      }
      // Cooldown elapsed: auto-recover (reset counter + clear lock) before verify.
      await this.prisma.userAccount.update({
        where: { id: user.id },
        data: { locked: false, lockedAt: null, lockedUntil: null, failedLoginCount: 0 },
      });
      user.failedLoginCount = 0;
      user.locked = false;
    }

    const ok = await verifyPassword(user.passwordHash, password as string);
    if (!ok) {
      const nextCount = user.failedLoginCount + 1;
      const shouldLock = nextCount >= this.lockoutThreshold;
      const lockedUntil =
        shouldLock && this.lockoutCooldownMinutes > 0
          ? new Date(Date.now() + this.lockoutCooldownMinutes * 60 * 1000)
          : null;
      await this.prisma.userAccount.update({
        where: { id: user.id },
        data: {
          failedLoginCount: nextCount,
          locked: shouldLock,
          lockedAt: shouldLock ? new Date() : null,
          lockedUntil,
        },
      });
      throw new UnauthorizedError('Invalid credentials');
    }

    // Success: reset counter, issue a fresh session + token pair.
    if (user.failedLoginCount !== 0) {
      await this.prisma.userAccount.update({
        where: { id: user.id },
        data: { failedLoginCount: 0 },
      });
    }

    const sessionId = await this.createSession(user.id);
    const tokens = await this.jwt.issuePair(user.id, user.role as Role, sessionId);
    return { user: toPublicUser(user), tokens };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    let claims;
    try {
      claims = await this.jwt.verify(refreshToken, 'refresh');
    } catch {
      throw new UnauthorizedError('Invalid refresh token');
    }

    const session = await this.prisma.jwtSession.findUnique({
      where: { sessionId: claims.sid },
    });
    if (!session || session.status !== 'ACTIVE' || session.revokedAt !== null) {
      throw new UnauthorizedError('Session is not active');
    }

    const accessToken = await this.jwt.issueAccess(claims.sub, claims.role, claims.sid);
    return { accessToken };
  }

  async logout(accessToken: string): Promise<void> {
    let claims;
    try {
      claims = await this.jwt.verify(accessToken, 'access');
    } catch {
      throw new UnauthorizedError('Invalid token');
    }

    await this.prisma.jwtSession.updateMany({
      where: { sessionId: claims.sid, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }
}
