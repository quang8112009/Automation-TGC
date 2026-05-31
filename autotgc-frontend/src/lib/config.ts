/**
 * Runtime configuration derived from Vite env. VITE_API_BASE defaults to an
 * empty string, which means "same origin" — the built app talks to the API at
 * the host nginx serves it from. During `vite dev` the dev proxy forwards /api
 * to the backend, so an empty base also works there.
 */
const rawBase = import.meta.env.VITE_API_BASE ?? '';

/** Normalized API base WITHOUT a trailing slash (so we can append '/api/...'). */
export const API_BASE = rawBase.replace(/\/+$/, '');

/**
 * Build an absolute (or same-origin relative) URL for an API path.
 * `path` should start with '/'.
 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * Build the WebSocket URL for the realtime endpoint. When API_BASE is empty we
 * derive ws(s):// from the current page origin; otherwise from API_BASE.
 */
export function wsUrl(path: string, accessToken: string): string {
  let origin: string;
  if (API_BASE) {
    origin = API_BASE;
  } else {
    origin = window.location.origin;
  }
  const url = new URL(path, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('access_token', accessToken);
  return url.toString();
}
