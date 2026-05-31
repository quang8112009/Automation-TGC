# Implementation Plan: Foundation & Deployment

## Overview

This plan converts the Foundation & Deployment design into incremental, code-focused tasks for the **Node.js 20 LTS + TypeScript** stack selected in `design.md` (Fastify, Prisma/PostgreSQL 16, ioredis/Redis, BullMQ, PM2, node-cron, argon2id, jose, fast-check + Vitest). Tasks are ordered by dependency: infrastructure foundation → data layer → auth domain → authorization → enforcement → platform integration → token management → scheduler → webhooks → deployment. Each task builds on prior tasks and ends by wiring its output into the running application, leaving no orphaned code.

Property-based tests use `fast-check` with a minimum of 100 generated cases each, and every property test is tagged in the format `// Feature: foundation-and-deployment, Property {n}: {property_text}` to map 1:1 with the design's Correctness Properties. External platform calls are mocked and clocks are injected so time-dependent properties are deterministic.

Tasks in the **Deployment to Production** epic (Task 16) operate against the live production server and are marked with **⚠️ [PRODUCTION SERVER]**. They require explicit human authorization before execution and cannot be reversed automatically.

## Tasks

- [ ] 1. Project scaffolding and infrastructure foundation
  - [ ] 1.1 Initialize TypeScript + Fastify project and test tooling
    - Create the project structure (`src/http`, `src/domain`, `src/infra`, `test`), `package.json`, `tsconfig.json`, ESLint/Prettier, and pin dependencies (Fastify, Prisma, ioredis, BullMQ, jose, argon2, node-cron) to exact versions
    - Configure Vitest as the test runner with `fast-check` wired in for property-based tests
    - Add a minimal Fastify bootstrap that binds to `127.0.0.1:3000` (loopback only)
    - _Requirements: 15.1, 19.1_

  - [ ] 1.2 Implement the Config / Secret loader with fail-fast and redaction
    - Implement `SecretLoader` with `require(name)` (throws `MissingSecretError` logging only the name), `optional(name)`, and `redact(text)` masking known secret values
    - Read all secrets from the Secret_Store (`.env` outside VCS / secret manager) at runtime; add `.gitignore` entries for `.env*`
    - Add a pino log serializer that routes every log line through `redact()`
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [ ]* 1.3 Write property test for secret redaction in logs
    - **Property 16: Secret values never appear in log output**
    - **Validates: Requirements 13.4**

  - [ ]* 1.4 Write property test for fail-fast on missing required secret
    - **Property 17: Fail-fast on missing required secret**
    - **Validates: Requirements 13.3**

  - [ ] 1.5 Implement the base error model and central error handler
    - Define the error taxonomy (`ValidationError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `LockedError` 423, `InternalError` 500) and a JSON response envelope
    - Register a Fastify error handler restricting emitted status codes to {200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502} and a 404 handler for unknown resources
    - Run error payloads through `SecretLoader.redact()`
    - _Requirements: 19.1, 19.4_

  - [ ]* 1.6 Write property test for allowed status codes
    - **Property 19: Responses use only the allowed status codes**
    - **Validates: Requirements 19.1**

  - [ ] 1.7 Implement pagination and CORS middleware
    - Add a pagination helper that reads `page` and `limit` query params and returns `total` in collection responses
    - Add a CORS plugin permitting the configured frontend origin
    - _Requirements: 19.2, 19.3_

  - [ ]* 1.8 Write property test for the pagination contract
    - **Property 20: Pagination contract**
    - **Validates: Requirements 19.2**

  - [ ] 1.9 Implement the startup bootstrap with root-execution guard
    - Add a `bootstrap()` that asserts `process.getuid() !== 0` (aborts with a secret-free error if running as root) and validates the full required-secret set before opening the listener
    - _Requirements: 14.1, 14.3, 13.3_

  - [ ]* 1.10 Write unit tests for the bootstrap guard
    - Test uid 0 aborts startup and a non-zero uid proceeds; test that a missing required secret aborts before the listener opens
    - _Requirements: 14.3, 13.3_

- [ ] 2. Implement the data layer
  - [ ] 2.1 Define the Prisma schema and initial migration
    - Model `User_Account`, `JWT_Session`, `ServiceAccount`, `ServicePermission`, `Platform_Token`, `TokenAlert`, and the `LeadAssignment` lookup per the Data Models section
    - Generate the initial migration targeting PostgreSQL 16 and the Prisma client
    - _Requirements: 1.5, 1.6, 1.8, 2.4, 3.1, 3.3, 4.x, 5.x, 8.1, 10.1, 12.x, 15.2_

  - [ ] 2.2 Implement the Redis client module
    - Configure an ioredis client (localhost) for caching, the BullMQ queue, and the revocation mirror
    - _Requirements: 15.3_

  - [ ]* 2.3 Write integration test for datastore connectivity and migrations
    - Verify PostgreSQL 16 is reachable, migrations apply cleanly, and Redis is reachable
    - _Requirements: 15.2, 15.3_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement auth credential and session primitives
  - [ ] 4.1 Implement the argon2id hashing module
    - Hash and verify user passwords and service-account secrets with argon2id (constant-time verify); never store or log plaintext; load hash parameters from config
    - _Requirements: 1.7, 8.6_

  - [ ]* 4.2 Write property test for password hashing
    - **Property 2: Passwords are stored only as verifiable salted hashes**
    - **Validates: Requirements 1.7**

  - [ ] 4.3 Implement JWT issue/verify with jose
    - Sign and verify Access_Tokens (exp = now + 24h) and Refresh_Tokens (exp = now + 30d) with `{sub, role, sid, typ}` claims; inject a clock for deterministic testing
    - _Requirements: 1.9, 2.2, 2.3, 2.8, 4.1, 4.2_

  - [ ] 4.4 Implement the Session / Revocation store
    - Persist `JWT_Session` rows in PostgreSQL and mirror revocation in Redis (`session:revoked:{sid}`, TTL = remaining refresh lifetime); implement `create`, `isRevoked`, `revoke`
    - _Requirements: 4.4, 5.1, 5.2, 5.3, 7.5_

  - [ ]* 4.5 Write property test for token issuance lifetimes and claims
    - **Property 3: Token issuance produces correct lifetimes and claims**
    - **Validates: Requirements 1.9, 2.2, 2.3, 2.8, 4.1, 4.2**

- [ ] 5. Implement the Auth_Service (registration, login, lockout, refresh, logout)
  - [ ] 5.1 Implement registration
    - Validate in order (email → password length → password match → username validity → username uniqueness) returning the specific status per Req 1.2–1.6 before any persistence; create the account with a hashed password, default ADMIN role, and issue a token pair
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [ ]* 5.2 Write property test for registration input validation
    - **Property 1: Registration input validation**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**

  - [ ] 5.3 Implement login with lockout
    - Check locked state before the password (locked → 423); increment the consecutive-failure counter on wrong password for an existing account and lock at 5 with a recorded timestamp; return 401 without touching the counter for unknown usernames; reset the counter on success; embed `{userId, role}` claims; empty fields → 400
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3_

  - [ ]* 5.4 Write property test for the failed-login counter and lockout state machine
    - **Property 4: Failed-login counter and lockout state machine**
    - **Validates: Requirements 2.4, 2.5, 2.7, 3.1, 3.3**

  - [ ]* 5.5 Write property test for locked-account login rejection
    - **Property 5: Locked accounts reject all logins**
    - **Validates: Requirements 3.2**

  - [ ]* 5.6 Write unit test for empty login fields
    - Empty username or password → 400 with the missing-field message
    - _Requirements: 2.6_

  - [ ] 5.7 Implement token refresh and logout
    - Refresh validates structure/expiry/revocation and mints a new Access_Token with the same `{sub, role, sid}`; logout marks the session REVOKED in PostgreSQL and Redis so both tokens stop working
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3_

  - [ ]* 5.8 Write property test for revoked-session rejection
    - **Property 6: Revoked sessions reject both tokens**
    - **Validates: Requirements 4.4, 5.1, 5.2, 5.3, 7.5**

  - [ ]* 5.9 Write unit test for malformed refresh token
    - Missing or malformed refresh token → 401
    - _Requirements: 4.5_

  - [ ] 5.10 Wire auth routes into Fastify
    - Register `POST /api/auth/register`, `/login`, `/refresh`, `/logout` and connect them to the Auth_Service
    - _Requirements: 1.1, 2.1, 4.1, 5.1, 7.4_

- [ ] 6. Implement authorization and service accounts
  - [ ] 6.1 Implement the Authorization_Service policy table
    - Implement `authorize(ctx, target)` as a pure function over the (role, module, action, lead-ownership) policy: ADMIN read+write everywhere; SALES read+status_update only on assigned leads, read-only Dashboard, 403 otherwise
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ]* 6.2 Write property test for RBAC decisions
    - **Property 8: RBAC decisions match the role/module/action/ownership policy**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8**

  - [ ] 6.3 Implement service-account identities and permission enforcement
    - Provision `ai-system` and `background-worker` service accounts with argon2id-hashed credentials from the Secret_Store and closed permission sets; reject interactive login on a service account (403); grant only in-set operations (out-of-set → 403)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6_

  - [ ]* 6.4 Write property test for service-account permission enforcement
    - **Property 9: Service-account permission enforcement**
    - **Validates: Requirements 8.2, 8.3, 8.4**

  - [ ]* 6.5 Write unit test for invalid service-account credential
    - Invalid or expired service-account credential → 401, no token issued
    - _Requirements: 8.5_

  - [ ]* 6.6 Write smoke test for role enum and service-account existence
    - Role enum is exactly {ADMIN, SALES}; AI System and Background Worker service accounts exist and load credentials from the Secret_Store
    - _Requirements: 6.1, 8.1, 8.6_

- [ ] 7. Implement authentication enforcement and the public allow-list
  - [ ] 7.1 Implement the authentication middleware and public allow-list
    - Verify Bearer token signature, expiry, and revocation; attach `{userId, role, sessionId}`; reject missing/malformed/expired/revoked tokens with 401; treat every endpoint as protected except the public allow-list (login, registration, refresh, health check, signature-verified webhooks)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 7.2 Write property test for authentication enforcement
    - **Property 7: Authentication enforcement on endpoints**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.5**

  - [ ] 7.3 Implement the RBAC middleware
    - Build the `ResourceTarget` for each route and call `authorize()` before the handler runs, denying with 403 without modifying the target
    - _Requirements: 6.5, 6.6_

  - [ ]* 7.4 Write smoke test for the public allow-list
    - Public allow-list is exactly login/register/refresh/health/verified-webhooks
    - _Requirements: 7.4_

- [ ] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement the platform adapter pattern
  - [ ] 9.1 Define the PlatformAdapter interface and AdapterRegistry
    - Define `PlatformAdapter` (publish/collectAnalytics/supports/capabilities), `AdapterRegistry` (additive `register`, `get`, `has`, `list`), and `UnsupportedPlatformError`/`UnsupportedOperationError` mapped to HTTP 400
    - _Requirements: 9.1, 9.3, 9.4, 9.5_

  - [ ]* 9.2 Write property test for adapter registry routing
    - **Property 10: Adapter registry routing correctness**
    - **Validates: Requirements 9.3, 9.4, 9.5**

  - [ ] 9.3 Implement the FacebookAdapter
    - Implement publish (`/{page-id}/feed`,`/photos`,`/videos`) and analytics (`/{post-id}/insights`) against a mockable HTTP client
    - _Requirements: 9.2_

  - [ ] 9.4 Implement the TikTokAdapter
    - Implement publish (`/post/publish/...`) and analytics (`/video/query/`) against a mockable HTTP client
    - _Requirements: 9.2_

  - [ ] 9.5 Implement the CustomCmsAdapter
    - Implement publish (`/cms/posts`) and analytics (`/cms/posts/{id}/analytics`)
    - _Requirements: 9.2_

  - [ ] 9.6 Implement the GA4Adapter
    - Implement analytics-only (`:runReport`); a publish request raises `UnsupportedOperationError` (→ 400)
    - _Requirements: 9.2, 9.5_

  - [ ] 9.7 Register the Phase-1 adapters at bootstrap
    - Register Facebook, TikTok, CustomCms, and GA4 adapters into the registry with their capability matrix
    - _Requirements: 9.2, 9.3_

  - [ ]* 9.8 Write smoke test for the adapter interface and capability matrix
    - Interface plus the four Phase-1 adapters are registered with the correct publish/analytics capabilities
    - _Requirements: 9.1, 9.2_

- [ ] 10. Implement the Token_Manager
  - [ ] 10.1 Implement Platform_Token storage and validity
    - Store metadata (platform, type, expiry/non-expiring, refresh window, status) in PostgreSQL with the secret value in the Secret_Store; record API-key/service-account credentials as non-expiring; implement the validity predicate (value present AND (non-expiring OR expiry in the future))
    - _Requirements: 10.1, 10.2, 10.4, 10.5_

  - [ ]* 10.2 Write property test for token storage round-trip
    - **Property 11: Platform token storage round-trip without secret leakage**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

  - [ ]* 10.3 Write property test for the token validity predicate
    - **Property 12: Token validity predicate**
    - **Validates: Requirements 10.5**

  - [ ] 10.4 Implement the Alert Dispatcher
    - Raise EXPIRY (immediately on expiry, even if a later refresh succeeds), PRE_EXPIRY_WARNING (on entering the refresh window before a successful refresh), and REFRESH_FAILURE (with reason); deliver all alerts to the ADMIN Dashboard notifications channel
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [ ]* 10.5 Write property test for token lifecycle alerting
    - **Property 15: Token lifecycle alerting**
    - **Validates: Requirements 12.1, 12.2, 12.4**

  - [ ] 10.6 Implement the refresh cycle and per-platform refresh
    - Select expiring tokens within their refresh window (window > job interval), skip non-expiring tokens; Facebook long-lived exchange → expiry + 60 days; TikTok refresh-token exchange → expiry + 24 hours; on failure retain the old token and record the reason
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6, 11.7_

  - [ ]* 10.7 Write property test for refresh cycle selection and expiry update
    - **Property 13: Refresh cycle selection and expiry update**
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.7**

  - [ ]* 10.8 Write property test for failed-refresh retention
    - **Property 14: Failed refresh retains the prior token and records the reason**
    - **Validates: Requirements 11.6**

  - [ ] 10.9 Implement the platform-token endpoints
    - `GET /api/platform-tokens` returns the public view (no secret value); `POST /api/platform-tokens/{platform}/refresh` refreshes and returns validity status; both behind auth + RBAC
    - _Requirements: 10.3, 11.5_

  - [ ]* 10.10 Write unit tests for the token endpoints and alert delivery
    - Refresh endpoint returns validity status; alerts are delivered to the ADMIN Dashboard notifications channel
    - _Requirements: 11.5, 12.3_

- [ ] 11. Implement the Scheduler and Token_Refresh_Job
  - [ ] 11.1 Implement the node-cron scheduler and wire the Token_Refresh_Job
    - Schedule `runRefreshCycle` at the configured interval (default 12h, honoring any configured interval); log the job name and failure timestamp on failure
    - _Requirements: 11.1, 17.1, 17.2, 17.3_

  - [ ]* 11.2 Write integration test for scheduler timing and failure logging
    - Scheduler fires the Token_Refresh_Job at the configured interval including a non-12h interval; a failed run logs the job name and failure timestamp
    - _Requirements: 11.1, 17.2, 17.3_

- [ ] 12. Implement the Webhook HMAC verification middleware
  - [ ] 12.1 Implement HMAC verification on webhook endpoints
    - Read the raw body before parsing, compute the HMAC with the per-source shared secret from the Secret_Store, and constant-time compare against the signature header; on match process the body and respond 2xx, on mismatch respond 401 without processing
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

  - [ ]* 12.2 Write property test for the webhook HMAC gate
    - **Property 18: Webhook HMAC verification gate**
    - **Validates: Requirements 20.1, 20.2, 20.3**

  - [ ]* 12.3 Write smoke test for webhook secret source
    - Webhook shared secrets resolve from the Secret_Store
    - _Requirements: 20.4_

- [ ] 13. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Author deployment configuration artifacts
  - [ ] 14.1 Author the Nginx reverse-proxy configuration
    - TLS termination on :443, :80 → 301 HTTPS serving only the ACME challenge (otherwise not served over HTTP), `proxy_pass` to the loopback backend, and a 502 when the backend is unreachable
    - _Requirements: 16.1, 16.2, 16.3, 16.4_

  - [ ] 14.2 Author the Let's Encrypt / certbot provisioning and renewal
    - Obtain the certificate via the ACME HTTP challenge and configure the certbot auto-renew timer to renew before expiry
    - _Requirements: 16.1, 16.5_

  - [ ] 14.3 Author the PM2 ecosystem configuration
    - Configure PM2 to run the backend as `autotgc`, restart on unexpected exit, and apply restart backoff so a flapping restart mechanism does not kill a healthy process
    - _Requirements: 15.4, 15.5, 14.1_

  - [ ] 14.4 Implement the health-check endpoint
    - Add `GET /healthz` (public allow-list) returning a JSON status for smoke checks
    - _Requirements: 7.4_

  - [ ]* 14.5 Write integration tests for proxy and process supervision
    - Nginx redirects HTTP→HTTPS and drops otherwise, forwards HTTPS to the backend, and returns 502 when the backend is down; PM2 restarts the backend on unexpected exit and does not kill a healthy process on restart-mechanism failure
    - _Requirements: 16.2, 16.3, 16.4, 15.4, 15.5_

- [ ] 15. Author the CI/CD pipeline
  - [ ] 15.1 Author the CI stages (build and verify)
    - Define checkout, install, lint, test, secret-scan (block secrets and the server host in the repo), and build/package (`tsc` → artifact); any failed stage stops the release and reports the failing stage
    - _Requirements: 13.2, 18.1, 18.5_

  - [ ] 15.2 Author the CD stages (deploy and post-deploy)
    - Resolve `SERVER_HOST` from the Secret_Store/vault, require a DNS A record mapping the domain to the server, deploy under the non-root `autotgc` user, run Prisma migrations, `pm2 reload`, and a `/healthz` + certificate-expiry check; any failed stage stops the release and reports it
    - _Requirements: 18.2, 18.3, 18.4, 18.5, 14.1, 14.2, 16.5_

  - [ ]* 15.3 Write integration test for pipeline halt-on-failure
    - The pipeline halts and reports the failing stage when a stage fails
    - _Requirements: 18.5_

  - [ ]* 15.4 Write smoke tests for pipeline guarantees
    - Secret-scan finds no secrets or server host in the repo; deploy targets the non-root Application_User; the DNS A-record gate is present
    - _Requirements: 13.2, 14.2, 18.4_

- [ ] 16. ⚠️ [PRODUCTION SERVER] Push and deploy to production
  - **These tasks operate against the live production server, transmit project code to a remote host, and are not automatically reversible. Obtain explicit human authorization before running them.**
  - [ ] 16.1 ⚠️ [PRODUCTION SERVER] Push the project and trigger the pipeline
    - Push to a new branch (not main) with upstream tracking and trigger the deployment pipeline; confirm the build, secret-scan, and packaging stages pass
    - _Requirements: 18.1, 13.2_

  - [ ] 16.2 ⚠️ [PRODUCTION SERVER] Execute the production deploy
    - Provision the `autotgc` non-root user and `.env` (chmod 600, outside VCS), resolve `SERVER_HOST` from the vault, verify the DNS A record, deploy the artifact, run Prisma migrations, start under PM2, and configure Nginx + certbot TLS
    - _Requirements: 18.2, 18.3, 18.4, 14.1, 14.2, 16.1, 16.5_

  - [ ]* 16.3 ⚠️ [PRODUCTION SERVER] Run post-deploy smoke checks
    - Verify `/healthz` responds over HTTPS, the Let's Encrypt certificate is served, the runtime is Node.js 20 LTS, PostgreSQL 16 and Redis are reachable, and the scheduler is active
    - _Requirements: 15.1, 15.2, 15.3, 16.1, 17.1_

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, but each one is the validation owner for the property/requirement it names.
- Property test tasks reference the design's Correctness Properties by number and run on `fast-check` with ≥100 generated cases, tagged `// Feature: foundation-and-deployment, Property {n}: ...`; external platform calls are mocked and clocks injected for determinism.
- Infrastructure criteria (process supervision, Nginx/TLS, scheduler timing, CI/CD control flow) are validated by integration and smoke tests rather than property tests, matching the design's Testing Strategy.
- Task 16 (⚠️ [PRODUCTION SERVER]) involves pushing code to and deploying on the live production server; treat it as high-risk and require explicit confirmation before execution.
- Each task references specific requirements for traceability; checkpoints (Tasks 3, 8, 13) ensure incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "14.1", "14.2", "14.3"] },
    { "id": 2, "tasks": ["1.5", "1.7", "1.9", "2.1", "2.2"] },
    { "id": 3, "tasks": ["1.3", "1.4", "1.6", "1.8", "1.10", "2.3", "4.1", "4.3", "4.4"] },
    { "id": 4, "tasks": ["4.2", "4.5", "5.1", "6.1", "6.3", "9.1", "10.1", "12.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "6.2", "6.4", "6.5", "6.6", "7.1", "9.2", "9.3", "9.4", "9.5", "9.6", "10.2", "10.3", "10.4", "12.2", "12.3", "14.4"] },
    { "id": 6, "tasks": ["5.4", "5.5", "5.6", "5.7", "7.2", "7.3", "7.4", "9.7", "10.5", "10.6", "14.5"] },
    { "id": 7, "tasks": ["5.8", "5.9", "5.10", "9.8", "10.7", "10.8", "11.1"] },
    { "id": 8, "tasks": ["10.9", "11.2", "15.1"] },
    { "id": 9, "tasks": ["10.10", "15.2"] },
    { "id": 10, "tasks": ["15.3", "15.4", "16.1"] },
    { "id": 11, "tasks": ["16.2"] },
    { "id": 12, "tasks": ["16.3"] }
  ]
}
```
