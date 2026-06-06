# Operator Deploy Runbook — `study-abroad-ai-advisor-suite` (Task 11.4)

This runbook deploys the `study-abroad-ai-advisor-suite` feature using the existing
`deploy/` scripts (Req 21.1, 21.2, 21.3, 21.4, 21.5). It MUST be run **by an operator from a
networked machine** that can reach the production server over SSH and that holds the deploy
secrets.

> The build agent verified deploy-readiness locally but did **not** push: the deploy
> credentials (`$env:DEPLOY_PASSWORD`) and the server host were not present in its sandbox.
> Nothing was transmitted anywhere.

## What the agent already verified (no server contact)

- `npm run build` in `autotgc-backend/` succeeds (Req 21.2). `dist/` produced, exit 0.
- `npm test` passes the full Vitest suite — **69 files, 640 tests passed** (5 pre-existing
  skipped), including all 10 new property-test files (admissions, roadmap, applications,
  applications-reminder, essays, essays-statemachine, interviewprep), each `fc.assert`
  running ≥ 100 generated cases (Req 19.1–19.10).
- `npm run secret-scan` passes: no secrets, server host, or `.env` committed (Req 21.4).
- Migration `prisma/migrations/0006_study_abroad_advisor/migration.sql` exists and is
  **additive only** — `CREATE TYPE` (3 enums: `EssayDocType`, `EssayStatus`,
  `ApplicationStatus`), `CREATE TABLE` (`AcademicProfile`, `EssayDraft`, `InterviewSession`,
  `ApplicationCase`, `ApplicationDueItem`, `ReminderLog`, `RoadmapNarrative`), `ADD COLUMN`
  (`DestinationProgram.minToefl`, `.minJlpt`, `.selectivityTier`), indexes, the
  `ReminderLog` `@@unique(dueItemId, windowKey)`, and `ON DELETE CASCADE` FKs to
  `CandidateProfile`/`ApplicationCase`. No `DROP` / `TRUNCATE` / `ALTER COLUMN` / `DELETE`
  (Req 21.1).
- `deploy/app-deploy.sh` runs `prisma migrate deploy` with a `prisma db push` fallback,
  `npm run build`, starts PM2 as the non-root `autotgc` user via `deploy/pm2.config.js`,
  and configures Nginx from `deploy/nginx-autotgc.conf` (Req 21.2, 21.3).
- `CRON_TIMELINE_SWEEP` is an **optional** secret with a default (`*/30 * * * *`) in
  `infra/jobs.ts`; it is NOT in `REQUIRED_SECRETS` (`config.ts`), so the written `.env`
  need not include it and the app will not fail fast on its absence (Req 21.4, 21.5).
- `GEMINI_API_KEY` remains optional: every AI surface (essay writer, interview agent,
  roadmap narrative) falls back to a deterministic, grounded result (`aiGenerated:false`)
  and never throws a 502 when the key is absent (Req 20.2).

## Prerequisites (operator machine)

- Windows PowerShell with the **Posh-SSH** module installed (`Install-Module Posh-SSH`).
- Network reachability to the production server (SSH/SFTP).
- The deploy password available to set as an environment variable for this session only.
- A backend tarball (regenerate — see "Rebuild the tarball" below).

## Step 0 — Set the deploy secret for this session (never write it to disk)

```powershell
# Prompts without echoing; value stays in-memory for this shell only.
$sec = Read-Host 'DEPLOY_PASSWORD' -AsSecureString
$env:DEPLOY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
```

Provide the real server host as a parameter (do NOT hardcode it in scripts/source).

## Rebuild the tarball

```powershell
cd C:\Users\PC\Documents\docs
tar -czf autotgc.tar.gz `
  --exclude='autotgc-backend/node_modules' `
  --exclude='autotgc-backend/.env' `
  --exclude='autotgc-backend/dist' `
  autotgc-backend
```

## Option A — Full redeploy (backend + frontend SPA), recommended for an existing server

`run-redeploy-full.ps1` uploads both tarballs, runs `redeploy2.sh` on the server
(`prisma generate` + `prisma migrate deploy` / `db push` to add the new models/columns,
`npm run build`, PM2 restart as `autotgc`), installs the Nginx vhost, and runs smoke +
health checks.

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
- PM2 process `autotgc-backend` `online` and **not** running as root.

> The bundled `-ServerHost` default in this script is a placeholder from a prior deploy.
> Always pass `-ServerHost` explicitly for the current target.

## Step — Post-deploy verification

```bash
# Backend direct
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz   # expect 200
curl -s http://127.0.0.1:3000/readyz                                     # expect ready

# New routes exist behind auth (expect 401 unauthenticated, NOT 404):
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3000/api/v1/candidates/_probe/admissions/score        # expect 401

# Confirm app is non-root under PM2:
sudo -u autotgc bash -lc 'pm2 list'
```

A `401` (not `404`) confirms the new routes are registered behind `requireAuth` + `rbacGuard`
(Req 21.6). The scheduled `study-timeline-sweep` job is listed at startup in the
"Scheduled jobs started" log line. New tables can be confirmed with:

```bash
sudo -u autotgc bash -lc 'cd /opt/autotgc && printf '"'"'SELECT 1 FROM "AcademicProfile" LIMIT 1;\n'"'"' > /tmp/ap.sql && npx prisma db execute --schema prisma/schema.prisma --file /tmp/ap.sql && echo ACADEMICPROFILE_OK; rm -f /tmp/ap.sql'
```

## Optional configuration

- `CRON_TIMELINE_SWEEP` (default `*/30 * * * *`) — cadence of the proactive due-item reminder
  sweep. Optional; override in `/opt/autotgc/.env` only if a different cadence is wanted.
- `GEMINI_API_KEY` — when present, essay drafts / interview questions / roadmap narratives are
  phrased by Gemini (`aiGenerated:true`); when absent, deterministic grounded fallbacks are used.

## Security notes

- The deploy password is read **only** from `$env:DEPLOY_PASSWORD` and is never written to disk
  by the scripts. The server host is passed as a parameter; do not hardcode host/IP/credentials
  in source.
- `app-deploy.sh` writes `/opt/autotgc/.env` with mode `600`, owned by `autotgc`.
- The app refuses to run as root (`assertNotRoot`) and fails fast on missing required secrets,
  logging only the secret name (Req 21.4, 21.5).
- All new endpoints sit behind `requireAuth` + `rbacGuard` with SALES assigned-only scoping
  resolved from `candidate.assignedTo`; no unauthenticated endpoints are added (Req 21.6). AI
  prompts never embed secret values (Req 20.4).
