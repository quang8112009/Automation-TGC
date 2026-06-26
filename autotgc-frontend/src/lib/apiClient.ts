/**
 * apiClient — a thin fetch wrapper that:
 *  - injects the Authorization: Bearer <accessToken> header,
 *  - parses the backend's { error: { code, message } } envelope into ApiError,
 *  - on a 401, attempts a single POST /api/auth/refresh and retries once,
 *  - on refresh failure, clears the session and notifies listeners so the app
 *    can redirect to /login.
 *
 * Auth endpoints (login/register/refresh) and webhooks do NOT require a token;
 * callers pass `auth: false` for those.
 */
import { apiUrl } from './config';
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  saveAccessToken,
} from './storage';
import type { ErrorEnvelope } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Listeners notified when the session becomes invalid (refresh failed). */
type AuthFailureListener = () => void;
const authFailureListeners = new Set<AuthFailureListener>();

export function onAuthFailure(listener: AuthFailureListener): () => void {
  authFailureListeners.add(listener);
  return () => authFailureListeners.delete(listener);
}

function notifyAuthFailure(): void {
  clearSession();
  for (const listener of authFailureListeners) listener();
}

export interface RequestOptions {
  method?: string;
  /** JSON body; serialized automatically. */
  body?: unknown;
  /** Extra query params (string/number/boolean values only; nullish skipped). */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Whether to attach the Bearer token (default true). */
  auth?: boolean;
  signal?: AbortSignal;
}

function buildPath(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = 'UNKNOWN';
  let message = res.statusText || 'Request failed';
  try {
    const data = (await res.json()) as Partial<ErrorEnvelope>;
    if (data && data.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
    }
  } catch {
    // Non-JSON error body; keep defaults.
  }
  return new ApiError(res.status, code, message);
}

/**
 * In-flight refresh guard (anti "refresh storm").
 *
 * When several requests 401 at the same time (e.g. a dashboard firing many
 * queries in parallel after the access token expired), each one would otherwise
 * POST /api/auth/refresh independently. That hammers the endpoint and, worse,
 * one refresh rotating/invalidating the token can race the others and cascade
 * into a spurious logout. We instead share ONE refresh promise: the first caller
 * starts it, everyone else awaits the same result, and the slot is cleared once
 * it settles so a later (genuinely new) 401 can refresh again.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(apiUrl('/api/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) return false;
    saveAccessToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

async function tryRefresh(): Promise<boolean> {
  // Coalesce concurrent refreshes onto a single in-flight request.
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', body, auth = true, signal } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const token = getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const fetchInit: RequestInit = { method, headers };
  if (body !== undefined) fetchInit.body = JSON.stringify(body);
  if (signal) fetchInit.signal = signal;
  return fetch(apiUrl(path), fetchInit);
}

/**
 * Perform an API request and parse the JSON response. Retries once after a
 * successful token refresh on 401.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const fullPath = buildPath(path, options.query);
  let res = await rawRequest(fullPath, options);

  if (res.status === 401 && options.auth !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await rawRequest(fullPath, options);
    } else {
      notifyAuthFailure();
      throw await parseError(res);
    }
    if (res.status === 401) {
      notifyAuthFailure();
      throw await parseError(res);
    }
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  // Non-JSON success (rare for this API) — return text coerced to T.
  return (await res.text()) as unknown as T;
}

/**
 * Download a file (e.g. lead export). Returns a Blob plus the suggested
 * filename parsed from the Content-Disposition header.
 */
export async function apiDownload(
  path: string,
  query?: RequestOptions['query'],
): Promise<{ blob: Blob; filename: string }> {
  const fullPath = buildPath(path, query);
  let res = await rawRequest(fullPath, { method: 'GET', auth: true });
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await rawRequest(fullPath, { method: 'GET', auth: true });
    } else {
      notifyAuthFailure();
      throw await parseError(res);
    }
  }
  if (!res.ok) throw await parseError(res);

  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? 'download';
  const blob = await res.blob();
  return { blob, filename };
}

/** Convenience helpers. */
export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) =>
    apiRequest<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  del: <T>(path: string, query?: RequestOptions['query']) =>
    apiRequest<T>(path, { method: 'DELETE', query }),
};
