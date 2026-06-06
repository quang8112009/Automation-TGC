# Tech Stack

## Backend (`autotgc-backend`)

- **Language/Runtime:** TypeScript (strict), Node.js >= 20, CommonJS modules.
- **Web framework:** Fastify 4 with `@fastify/cors`.
- **ORM/Database:** Prisma 5 over PostgreSQL 16.
- **Cache/Queue:** Redis via `ioredis`.
- **Auth:** JWT via `jose`; password hashing via `argon2`.
- **Logging:** `pino`, wired at the process boundary with secret redaction.
- **Testing:** Vitest, with `fast-check` for property-based testing.
- **AI (text):** DeepSeek V4 via an OpenAI-compatible ChatCompletions gateway (`src/infra/aiTextClient.ts`; the `GeminiClient` name is a backward-compat alias, and the `GEMINI_*` text env keys are legacy names that now point at the DeepSeek gateway).
- **AI (media):** Google Gemini / VEO image+video generation, a separate route (`GEMINI_IMAGE_*`, `VEO_*` → `POST {base}/images/generations`); not migrated to DeepSeek.

## Deployment

- **Process manager:** PM2 (`deploy/pm2.config.js`), runs as the non-root `autotgc` user from `/opt/autotgc`.
- **Reverse proxy:** Nginx (SSL termination).
- **Provisioning/deploy:** shell scripts in `deploy/` (`provision.sh`, `install-pg16.sh`) orchestrated from `deploy/run-deploy.ps1` (PowerShell + Posh-SSH).

## Common commands

Run from the `autotgc-backend/` directory.

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Dev (ts-node) | `npm run dev` |
| Build (tsc → `dist/`) | `npm run build` |
| Start (compiled) | `npm start` |
| Run tests once | `npm test` |
| Watch tests | `npm run test:watch` |
| Lint | `npm run lint` |
| Generate Prisma client | `npm run prisma:generate` |
| Apply migrations | `npm run prisma:migrate` |
| Scan for committed secrets | `npm run secret-scan` |

> On Windows the default shell is `cmd`. Use `&` (not `&&`) as the command separator. Do not run watch/dev/server commands as blocking shell calls.

## Conventions & rules

- **Strict TypeScript.** No implicit `any` at boundaries; narrow `unknown` request input with small helpers (e.g. `asString`, `asInt`) rather than casting blindly.
- **Layering.** Keep domain logic pure and framework-free in services and `*Machine`/scoring modules; the route layer (`routes/index.ts`) only shapes requests/responses, wires auth/RBAC, and calls services.
- **Errors.** Throw typed `AppError` subclasses from `infra/errors.ts` (`ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `LockedError`). Responses use the `{ error: { code, message } }` envelope. Only the allowed status-code set is permitted (200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502).
- **State machines.** Status changes go through guarded transition functions that return `409` on illegal transitions. Model new lifecycles the same way.
- **Numeric safety.** Guard against divide-by-zero in derived metrics; surface `INSUFFICIENT_DATA` rather than emitting misleading rates.
- **Security:**
  - Never log secret values; route messages through the logger's `redact`.
  - Load config via the `SecretLoader` and **fail fast** on missing required secrets, logging only the secret name.
  - Refuse to run as root (`assertNotRoot`).
  - Verify webhook HMAC signatures with a constant-time compare **before** parsing the body.
  - Never hardcode server hosts, IPs, or credentials. Use env vars / vault; keep real `.env` out of git (see `.env.example`).
- **RBAC.** Authorization is pure policy evaluation in `auth/rbac.ts`; enforce per-route via `rbacGuard`. SALES is assigned-only for leads and read-only for the dashboard.
