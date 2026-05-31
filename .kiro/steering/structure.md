# Project Structure

The workspace root (`docs/`) holds use-case/specification documentation alongside the backend implementation.

## Top level

```
docs/
├── .kiro/
│   ├── specs/        # Feature specs (requirements/design/tasks per feature)
│   └── steering/     # These guidance docs
├── autotgc-backend/  # The Node.js/TypeScript backend (the codebase)
├── API_Catalog.md    # Authoritative catalog of internal + external APIs (Vietnamese)
├── Data_Flow_Analytics_to_Strategy.md
└── <Use-case folders>/   # Module use cases as markdown (e.g. Content_Generation/, Lead_Management/)
```

The use-case folders (`Analytics_&_Optimization/`, `Authentication/`, `Content_Generation/`, `Content_Strategy/`, `Lead_Management/`, `Operational_Dashboard/`, `Publishing/`) are product documentation, mostly in Vietnamese. They are the source of truth for behavior; treat `API_Catalog.md` as the integration contract.

## Backend layout (`autotgc-backend/src`)

```
src/
├── index.ts            # Process entrypoint: load secrets/config, root guard, listen, graceful shutdown
├── app.ts              # buildApp(): Fastify instance, CORS, global error + 404 handlers, route registration
├── routes/index.ts     # All HTTP routes; request/response shaping + auth/RBAC wiring (thin layer)
├── auth/               # authService, jwt, password (argon2), rbac (pure policy), validation
├── leads/              # leadService, statusMachine (guarded transitions), validation/attribution
├── content/            # stateMachine (content lifecycle)
├── analytics/          # scoring (pure rate/label logic), insightStateMachine
├── dashboard/          # helpers (staleness/upcoming calculations)
├── http/               # authMiddleware (requireAuth, getAuth, rbacGuard)
└── infra/              # config, secrets (SecretLoader), errors, logger, hmac, prisma
```

Other backend directories:

```
autotgc-backend/
├── prisma/schema.prisma   # Single source of truth for the data model (Postgres)
├── test/                  # Vitest suites (auth, leads/infra, scoring, state machines)
├── deploy/                # PM2 config, Nginx conf, provisioning + deploy scripts
├── scripts/secret-scan.js # Pre-commit-style secret scanner
├── dist/                  # Compiled output (build artifact; do not edit)
└── .env.example           # Env template; real .env is never committed
```

## Where things go

- **New domain logic** → a pure module under the matching `src/<module>/` folder (service + any `*Machine`/scoring helpers). Keep it free of Fastify/Prisma-request concerns where practical.
- **New endpoints** → register in `routes/index.ts`, delegating to a service and guarding with `auth` + `rbacGuard`.
- **New data models / fields** → edit `prisma/schema.prisma`, run `prisma:generate`, and add a migration.
- **Cross-cutting concerns** (config keys, error types, logging, signatures) → `src/infra/`.
- **Tests** → `test/*.test.ts` (Vitest); use `fast-check` for property-based coverage of pure logic.

## Naming conventions

- Files: `camelCase.ts` (e.g. `leadService.ts`, `insightStateMachine.ts`).
- Pure state-transition modules are suffixed `*Machine` / `statusMachine`.
- One module folder per domain; match the module names used in `rbac.ts` (`strategy`, `generation`, `publishing`, `analytics`, `feedback`, `lead_management`, `settings`, `dashboard`).
