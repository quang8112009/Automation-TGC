# Operator Deploy Runbook — `admin-oversight-rbac-notifications` (Task 11.3)

This runbook deploys the `admin-oversight-rbac-notifications` upgrade using the existing
`deploy/` scripts (Req 12.1, 12.3, 12.4, 12.5). It MUST be run **by an operator from a
networked machine** that can reach the production server over SSH and that holds the deploy
secrets.

> The build agent verified deploy-readiness locally but did **not** push: the deploy
> credentials (`$env:DEPLOY_PASSWORD`) and the server host were not present in its sandbox.
> Nothing was transmitted anywhere. Do **not** hardcode the host/IP or password in source —
> pass the host as a parameter and read the password only from `$env:DEPLOY_PASSWORD`.

## What the agent already verified (no server contact)

- `npm run build` in `autotgc-backend/` succeeds (Req 12.2). `tsc -p tsconfig.json` exits 0;
  `dist/` is produced.
- Migration `prisma/migrations/0003_admin_oversight/migration.sql` exists and is
  **additive only** — two `CREATE TABLE` (`Notification`, `ActivityLog`), five `CREATE INDEX`,
  and one `ADD CONSTRAINT` FK (`Notification_recipientUserId_fkey` →
  `UserAccount(id)` `ON DELETE CASCADE`). No `DROP` / `TRUNCATE` / `DELETE` / `ALTER COLUMN`,
  no structural change to any existing table, and **`AuditEntry` is untouched** (Req 12.1).
  The only `ALTER TABLE` targets the **new** `Notification` table (adding its FK).
- `deploy/app-deploy.sh` runs `prisma migrate deploy` with a `prisma db push` fallback,
  then `npm run build`, starts PM2 as the non-root `autotgc` user via `deploy/pm2.config.js`,
  and configures Nginx from `deploy/nginx-autotgc.conf` (Req 12.2, 12.3). The new
  `Notification` + `ActivityLog` tables therefore apply on deploy without manual SQL.
- **No new required secret** was introduced: `REQUIRED_SECRETS` in `src/infra/config.ts` is
  unchanged (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`). The app will **not** fail-fast on
  this feature, and the written `.env` needs no new keys (Req 12.4).
- All new endpoints sit behind `requireAuth` + `rbacGuard` (Req 12.5), wired in `src/app.ts`:
  - `GET /api/v1/notifications`, `GET /api/v1/notifications/unread-count`,
    `POST /api/v1/notifications/:id/read` → `dashboard/read` (self-scoped; owner/existence
    checks in `NotificationService.markRead`).
  - `GET /api/v1/activity` → `dashboard/company_stats` (ADMIN-only; SALES → 403).
  - `GET/POST /api/v1/users`, `POST /api/v1/users/:id/{lock,unlock,role,reset-password}` →
    `rbacGuard({ module: 'user_management' })` (ADMIN-only; SALES → 403).
  No unauthenticated endpoints are added.

## Prerequisites (operator machine)

- Windows PowerShell with the **Posh-SSH** module installed (`Install-Module Posh-SSH`).
- Network reachability to the production server (SSH/SFTP).
- The deploy password available to set as an environment variable for this session only.
- The backend tarball at `C:\Users\PC\Documents\docs\autotgc.tar.gz` (regenerate if stale —
  see "Rebuild the tarball" below).

## Step 0 — Set the deploy secret for this session (never write it to disk)

```powershell
# Prompts without echoing; value stays in-memory for this shell only.
$sec = Read-Host 'DEPLOY_PASSWORD' -AsSecureString
$env:DEPLOY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
```

Provide the real server host as a parameter (do NOT hardcode it in scripts/source).

## Option A — Full redeploy (backend + frontend SPA), recommended for an existing server

`run-redeploy-full.ps1` uploads both tarballs, runs `redeploy2.sh` on the server
(`prisma generate` + `prisma db push`/`migrate deploy` to add the new `Notification` +
`ActivityLog` tables, `npm run build`, PM2 restart as `autotgc`), installs the Nginx vhost,
and runs smoke + health checks.

```powershell
cd C:\Users\PC\Documents\docs\autotgc-backend\deploy
.\run-redeploy-full.ps1 `
  -ServerHost '<SERVER_HOST_OR_IP>' `
  -BeTar 'C:\Users\PC\Documents\docs\autotgc.tar.gz' `
  -FeTar 'C:\Users\PC\Documents\docs\autotgc-frontend-dist.tar.gz'
```

Watch for these markers in the output:
- `redeploy2.sh FULL OUTPUT` ending in `DONE`
- `HEALTHZ=200`, `READYZ_CODE=200`
- `POST-DEPLOY VERIFY (backend direct :3000)` with healthy codes
- PM2 process `autotgc-backend` `online` and **not** running as root

> Note: the bundled `-ServerHost` default in this script is a placeholder from a prior
> deploy. Always pass `-ServerHost` explicitly for the current target.

## Option B — First-time provision + app deploy (fresh server)

Stage 1 uploads the package and provisions Node/PG16/Redis/Nginx/PM2/user:

```powershell
cd C:\Users\PC\Documents\docs\autotgc-backend\deploy
.\run-deploy.ps1 -ServerHost '<SERVER_HOST_OR_IP>' -TarPath 'C:\Users\PC\Documents\docs\autotgc.tar.gz'
```

Stage 2 — run the app deploy on the server (over your SSH session). `app-deploy.sh`
expects these env vars exported in the remote shell (operator secrets — never commit):
`AUTOTGC_DB_PASSWORD`, `PG16_PORT`, `JWT_SECRET`, `WH_FB`, `WH_WEB`. No new secret is
required for this feature.

```bash
# On the server, as an admin user that can sudo to autotgc:
export AUTOTGC_DB_PASSWORD='<db-pass>' PG16_PORT='5434' \
       JWT_SECRET='<long-random>' WH_FB='<fb-secret>' WH_WEB='<web-secret>'
bash /opt/autotgc-src/deploy/app-deploy.sh
```

`app-deploy.sh` runs `npx prisma migrate deploy` (with a `prisma db push` fallback) so
migration `0003_admin_oversight` applies the new tables, then `npm run build`, PM2 start as
`autotgc`, and Nginx reload. Expect the tail to print `LOCAL_HEALTH=200`, `VIA_NGINX=200`,
`DONE`.

## Migration `0003_admin_oversight` — what it applies

The migration is **additive only** and creates exactly:

- `CREATE TABLE "Notification"` (`id`, `recipientUserId`, `kind`, `message`, `refType?`,
  `refId?`, `read` default `false`, `createdAt`).
- `CREATE TABLE "ActivityLog"` (`id`, `actorUserId`, `action`, `targetType`, `targetId`,
  `detail` JSONB default `'{}'`, `createdAt`).
- `CREATE INDEX` ×5: `Notification(recipientUserId, createdAt)`, `Notification(read)`,
  `ActivityLog(actorUserId)`, `ActivityLog(targetType, targetId)`, `ActivityLog(createdAt)`.
- `ADD CONSTRAINT "Notification_recipientUserId_fkey"` → `UserAccount(id)` `ON DELETE CASCADE`.

It does **not** modify, drop, lock, or rewrite any existing table, and does not touch
`AuditEntry`. Safe to apply online.

## Step — Post-deploy verification

```bash
# Backend direct
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz   # expect 200
curl -s http://127.0.0.1:3000/readyz                                     # expect ready
# New endpoints exist behind auth (expect 401 unauthenticated, NOT 404):
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/v1/users          # expect 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/v1/notifications  # expect 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/v1/activity       # expect 401
# Confirm app is non-root under PM2:
sudo -u autotgc bash -lc 'pm2 list'
```

A `401` (not `404`) on `/api/v1/users`, `/api/v1/notifications`, and `/api/v1/activity`
confirms the new routes are registered behind `requireAuth` + `rbacGuard` (Req 12.5). New
tables can be confirmed with:

```bash
sudo -u autotgc bash -lc 'cd /opt/autotgc && printf '"'"'SELECT 1 FROM "Notification" LIMIT 1;\n'"'"' > /tmp/n.sql && npx prisma db execute --schema prisma/schema.prisma --file /tmp/n.sql && echo NOTIFICATION_OK; rm -f /tmp/n.sql'
sudo -u autotgc bash -lc 'cd /opt/autotgc && printf '"'"'SELECT 1 FROM "ActivityLog" LIMIT 1;\n'"'"' > /tmp/a.sql && npx prisma db execute --schema prisma/schema.prisma --file /tmp/a.sql && echo ACTIVITYLOG_OK; rm -f /tmp/a.sql'
```

## Rebuild the tarball (if source changed)

```powershell
cd C:\Users\PC\Documents\docs
tar -czf autotgc.tar.gz `
  --exclude='autotgc-backend/node_modules' `
  --exclude='autotgc-backend/.env' `
  --exclude='autotgc-backend/dist' `
  autotgc-backend
```

## Security notes

- The deploy password is read **only** from `$env:DEPLOY_PASSWORD` and is never written to disk
  by the scripts. The server host is passed as a parameter; do not hardcode host/IP/credentials
  in source.
- `app-deploy.sh` writes `/opt/autotgc/.env` with mode `600`, owned by `autotgc`.
- The app refuses to run as root (`assertNotRoot`) and fails fast on missing required secrets,
  logging only the secret name. This feature adds **no** new required secret, so it cannot
  introduce a new fail-fast condition (Req 12.4).
- New endpoints (`/api/v1/users*`, `/api/v1/notifications*`, `/api/v1/activity`) sit behind
  `requireAuth` + `rbacGuard`; no unauthenticated endpoints are added (Req 12.5).
