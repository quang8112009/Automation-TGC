/**
 * JWT issue/verify with jose. Access 24h / Refresh 30d, claims {sub, role, sid, typ}.
 * Implements Foundation Req 1.9, 2.2, 2.3, 2.8, 4.1, 4.2.
 */
import { SignJWT, jwtVerify } from 'jose';

export type Role = 'ADMIN' | 'SALES';
export type TokenType = 'access' | 'refresh';

export interface TokenClaims {
  sub: string; // userId
  role: Role;
  sid: string; // session id
  typ: TokenType;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class JwtService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly accessTtlHours: number,
    private readonly refreshTtlDays: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  private async sign(claims: TokenClaims, expSeconds: number): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ role: claims.role, sid: claims.sid, typ: claims.typ })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt(iat)
      .setExpirationTime(iat + expSeconds)
      .sign(this.key);
  }

  async issuePair(userId: string, role: Role, sessionId: string): Promise<TokenPair> {
    const accessToken = await this.sign(
      { sub: userId, role, sid: sessionId, typ: 'access' },
      this.accessTtlHours * 3600,
    );
    const refreshToken = await this.sign(
      { sub: userId, role, sid: sessionId, typ: 'refresh' },
      this.refreshTtlDays * 86400,
    );
    return { accessToken, refreshToken };
  }

  async issueAccess(userId: string, role: Role, sessionId: string): Promise<string> {
    return this.sign({ sub: userId, role, sid: sessionId, typ: 'access' }, this.accessTtlHours * 3600);
  }

  async verify(token: string, expectedType: TokenType): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
    if (payload.typ !== expectedType) {
      throw new Error('Wrong token type');
    }
    return {
      sub: String(payload.sub),
      role: payload.role as Role,
      sid: String(payload.sid),
      typ: payload.typ as TokenType,
    };
  }
}
