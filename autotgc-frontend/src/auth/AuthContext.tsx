/**
 * AuthContext — holds the authenticated user/session and exposes login,
 * register, and logout. The session is persisted in localStorage so a reload
 * restores it. The apiClient handles token refresh transparently; when refresh
 * fails it fires onAuthFailure, which we subscribe to here to clear state and
 * force the user back to /login.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { login as apiLogin, logout as apiLogout, register as apiRegister } from '../api/auth';
import { onAuthFailure } from '../lib/apiClient';
import {
  clearSession,
  loadSession,
  saveSession,
} from '../lib/storage';
import type { PublicUser, Role } from '../lib/types';

interface AuthContextValue {
  user: PublicUser | null;
  role: Role | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(() => loadSession()?.user ?? null);

  // React to refresh failures from the API client.
  useEffect(() => {
    return onAuthFailure(() => {
      setUser(null);
    });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiLogin(username, password);
    saveSession({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      user: result.user,
    });
    setUser(result.user);
  }, []);

  const register = useCallback(async (username: string, email: string, password: string) => {
    const result = await apiRegister(username, email, password);
    saveSession({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      user: result.user,
    });
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Even if the server call fails, clear local state.
    }
    clearSession();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      role: user?.role ?? null,
      isAuthenticated: user !== null,
      login,
      register,
      logout,
    }),
    [user, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
