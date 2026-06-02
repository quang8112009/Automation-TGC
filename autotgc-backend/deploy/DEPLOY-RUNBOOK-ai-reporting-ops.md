# Operator Deploy Runbook — `ai-reporting-and-ops-enhancements` (Task 11.3)

This runbook deploys the `ai-reporting-and-ops-enhancements` upgrade using the existing
`deploy/` scripts (Req 15.1, 15.2, 15.3). It MUST be run **by an operator from a networked
machine** that can reach the production server over SSH and that holds the deploy secrets.

> The build agent verified deploy-readiness locally but did **not** push: the deploy
> credentials (`$env:DEPLOY_PASSWORD`) and the server host were not present in its sandbox.
> Nothing was transmitted anywhere.

## What the agent already verified (no server contact)

- `npm run build` in `autotgc-backend/` succeeds (Req 15.2). `dist/index.js` produced.
- Migration `prisma/migrations/0002_ai_reporting_ops/migration.sql` exists and is
  **additive only** — `CREATE TYPE` (4 enums), `CREATE TABLE` (`CompanyReport`,
  `DocumentChecklistItem`, `DocumentTypeCatalog`), `ADD COLUMN` (`ContentDraft.priorityIndex`,
  `LearningInsight.priorityIndex`), indexes, and one `ON DELETE CASCADE` FK. No
  `DROP` / `TRUNCATE` / `ALTER COLUMN` / `DELETE` (Req 15.1).
- `deploy/app-deploy.sh` runs `prisma migrate deploy` with a `prisma db push` fallback,
  `npm run build`, starts PM2 as the non-root `autotgc` user via `deploy/pm2.config.js`,
  and configures Nginx from `deploy/nginx-autotgc.conf` (Req 15.2, 15.3).
- `CRON_WEEKLY_REPORT` / `CRON_MONTHLY_REPORT` are **optional** secrets with defaults
  (`0 1 * * 1` / `0 2 1 * *`) in `reportScheduler.ts`; they are NOT in `REQUIRED_SECRETS`
  (`config.ts`), so the written `.env` need not include them and the app will not fail
  fast on their absence (Req 15.4).
- A deployable tarball was produced at `C:\Users\PC\Documents\docs\autotgc.tar.gz`
  (excludes `node_modules`, `.env`, `dist`; root dir `autotgc-backend/`).

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
(`prisma generate` + `prisma db push` to add the new models/columns, `npm run build`,
PM2 restart as `autotgc`), installs the Nginx vhost, and runs smoke + health checks.

```powershell
cd C:\Users\PC\Documents\docs\autotgc-backend\deploy
.\run-redeploy-full.ps1 `
  -ServerHost '<SERVER_HOST_OR_IP>' `
  -BeTar 'C:\Users\PC\Documents\docs\autotgc.tar.gz' `
  -FeTar 'C:\Users\PC\Documents\docs\autotgc-frontend-dist.tar.gz'
```

Watch for these markers in the output:
- `redeploy2.sh FULL OUTPUT` ending in `DONE`
- `HEALTH=200`, `READYZ=200`
- `POST-DEPLOY VERIFY (backend direct :3000)` → `HEALTHZ=200`
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
`AUTOTGC_DB_PASSWORD`, `PG16_PORT`, `JWT_SECRET`, `WH_FB`, `WH_WEB`.

```bash
# On the server, as an admin user that can sudo to autotgc:
export AUTOTGC_DB_PASSWORD='<db-pass>' PG16_PORT='5434' \
       JWT_SECRET='<long-random>' WH_FB='<fb-secret>' WH_WEB='<web-secret>'
bash /opt/autotgc-src/deploy/app-deploy.sh
```

Expect the tail to print `LOCAL_HEALTH=200`, `VIA_NGINX=200`, `DONE`.

## Step — Post-deploy verification

```bash
# Backend direct
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz   # expect 200
curl -s http://127.0.0.1:3000/readyz                                     # expect ready
# New reporting endpoints exist behind auth (expect 401 unauthenticated, NOT 404):
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/v1/reports
# Confirm app is non-root under PM2:
sudo -u autotgc bash -lc 'pm2 list'
```

A `401` (not `404`) on `/api/v1/reports` confirms the new routes are registered behind
auth + RBAC (Req 15.5). New tables can be confirmed with:

```bash
sudo -u autotgc bash -lc 'cd /opt/autotgc && printf '"'"'SELECT 1 FROM "CompanyReport" LIMIT 1;\n'"'"' > /tmp/cr.sql && npx prisma db execute --schema prisma/schema.prisma --file /tmp/cr.sql && echo COMPANYREPORT_OK; rm -f /tmp/cr.sql'
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
  logging only the secret name (Req 15.4).
- New endpoints sit behind `requireAuth` + `rbacGuard`; no unauthenticated endpoints are added
  (Req 15.5).
