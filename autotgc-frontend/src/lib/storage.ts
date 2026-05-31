/**
 * localStorage-backed persistence for the authenticated session. We store the
 * access token, refresh token, and the public user record so a page reload can
 * restore the session without an extra round-trip.
 */
import type { PublicUser } from './types';

const ACCESS_KEY = 'autotgc.accessToken';
const REFRESH_KEY = 'autotgc.refreshToken';
const USER_KEY = 'autotgc.user';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export function loadSession(): StoredSession | null {
  const accessToken = localStorage.getItem(ACCESS_KEY);
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  const userRaw = localStorage.getItem(USER_KEY);
  if (!accessToken || !refreshToken || !userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as PublicUser;
    return { accessToken, refreshToken, user };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(ACCESS_KEY, session.accessToken);
  localStorage.setItem(REFRESH_KEY, session.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function saveAccessToken(accessToken: string): void {
  localStorage.setItem(ACCESS_KEY, accessToken);
}

export function clearSession(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}
