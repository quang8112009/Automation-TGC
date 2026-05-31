# AutoTGC Frontend

A single-page application (SPA) for the AutoTGC content-marketing automation
platform. Built with Vite + React 18 + TypeScript (strict), react-router-dom v6,
and TanStack Query v5.

## Quick start

```sh
npm install
npm run dev      # http://localhost:5173 (proxies /api -> backend dev server)
```

The dev server proxies `/api`, `/api/v1/ws` (WebSocket), `/healthz`, `/readyz`,
and `/docs` to the backend. By default it targets `http://localhost:3000`
(the Fastify dev port). Override with the `BACKEND_ORIGIN` env var:

```sh
$env:BACKEND_ORIGIN = "http://localhost:4000"; npm run dev
```

## Build

```sh
npm run build    # tsc -b && vite build  -> static files in dist/
npm run preview  # preview the production build
```

The `dist/` output is static and intended to be served by nginx at the **same
origin** as the API, so no proxy is needed in production.

## Configuration

`VITE_API_BASE` controls the API base URL (see `.env.example`):

- **empty (default)** — same-origin relative paths (`/api/...`). Use this when
  nginx serves the SPA and the API from the same host.
- **absolute URL** — point the SPA at an API on a different origin.

No server hosts, IPs, tokens, or secrets are hardcoded in the app. The only
host reference is the dev-only proxy default in `vite.config.ts`, which is not
included in the production bundle.

## Architecture

- `src/lib/apiClient.ts` — fetch wrapper that injects the Bearer token, parses
  the `{ error: { code, message } }` envelope, and refreshes the access token
  once on a 401 before redirecting to login.
- `src/auth/AuthContext.tsx` — session state (`user`, `role`, `login`,
  `register`, `logout`) persisted in localStorage.
- `src/realtime/RealtimeContext.tsx` — WebSocket client (`/api/v1/ws`) with
  auto-reconnect/backoff, heartbeat ping, notification bell buffer, and
  react-query cache invalidation per topic.
- `src/api/*` — typed endpoint modules per backend domain.
- `src/pages/*` — Dashboard, Leads, Strategy, Drafts, Publishing, Insights,
  Workflows, Platform Tokens, Settings, Login, Register.
