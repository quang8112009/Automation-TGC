#!/usr/bin/env bash
# Re-sync, install, append new env keys, db push (adds new models), build, restart.
#
# `set -e` ADDED: previously this ran with only `set -uo pipefail`, so a failed
# install/generate/db-push/build did NOT abort and the script still printed DONE
# and restarted PM2 with a possibly broken build. With -e, any unguarded failure
# aborts; steps that are allowed to fail carry an explicit `|| true`.
set -euo pipefail
APP_DIR=/opt/autotgc
SRC_DIR=/opt/autotgc-src

echo "=== sync (preserve .env, media) ==="
rsync -a --delete --exclude node_modules --exclude .env --exclude media "${SRC_DIR}/" "${APP_DIR}/"
chown -R autotgc:autotgc "${APP_DIR}"

cd "${APP_DIR}"
echo "=== install deps ==="
sudo -u autotgc bash -lc "cd ${APP_DIR} && npm install --no-audit --no-fund 2>&1 | tail -3"

echo "=== ensure new env keys present (append if missing) ==="
add_key() { grep -q "^$1=" "${APP_DIR}/.env" || echo "$1=$2" >> "${APP_DIR}/.env"; }
# Generate strong random service-account credentials if not already set.
SA_AI="$(head -c 18 /dev/urandom | base64 | tr -d '+/=')"
SA_BW="$(head -c 18 /dev/urandom | base64 | tr -d '+/=')"
add_key SERVICE_ACCOUNT_AI_SYSTEM_SECRET "${SA_AI}"
add_key SERVICE_ACCOUNT_BACKGROUND_WORKER_SECRET "${SA_BW}"
# Per-process Prisma pool cap (api + worker are separate processes now).
add_key DB_CONNECTION_LIMIT "10"
chmod 600 "${APP_DIR}/.env"; chown autotgc:autotgc "${APP_DIR}/.env"

echo "=== prisma generate + db push (adds ServiceAccount/ServicePermission/LeadAssignment) ==="
# SAFETY: `db push --accept-data-loss` is DESTRUCTIVE — on any schema drift it can
# DROP columns/tables to match schema.prisma, with no migration record and no
# rollback. Take a timestamped Postgres backup FIRST so a bad diff is recoverable.
# (Planned: migrate this path to reviewed `prisma migrate deploy` — see
# prisma/migrations/MIGRATION-BASELINE-RUNBOOK.md. Not switched here.)
echo "=== pre-push Postgres backup ==="
BACKUP_DIR=/var/backups/autotgc
mkdir -p "${BACKUP_DIR}"
BACKUP_FILE="${BACKUP_DIR}/autotgc-$(date +%Y%m%d-%H%M%S).sql"
# Derive connection from the app's .env DATABASE_URL; pg_dump must succeed before
# we allow the destructive push. If the backup fails, abort (set -e + explicit check).
if sudo -u autotgc bash -lc 'cd '"${APP_DIR}"' && set -a && . ./.env && set +a && DUMP_URL="${DATABASE_URL%%\?*}" && PGD="$(ls /usr/lib/postgresql/*/bin/pg_dump 2>/dev/null | sort -V | tail -1)"; "${PGD:-pg_dump}" "$DUMP_URL"' > "${BACKUP_FILE}" 2>/tmp/pgdump.err; then
  echo "BACKUP_OK=${BACKUP_FILE} ($(wc -c < "${BACKUP_FILE}") bytes)"
else
  echo "BACKUP_FAILED — refusing to run destructive db push. See /tmp/pgdump.err:"; tail -5 /tmp/pgdump.err
  exit 1
fi
sudo -u autotgc bash -lc "cd ${APP_DIR} && npx prisma generate 2>&1 | tail -2 && npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -8"

echo "=== build ==="
sudo -u autotgc bash -lc "cd ${APP_DIR} && npm run build 2>&1 | tail -5"

echo "=== restart (clean): split api + worker processes ==="
# Remove the OLD single-process app name (pre-split) and any prior split apps,
# then start the two-process topology from the PM2 config.
sudo -u autotgc bash -lc "cd ${APP_DIR} && pm2 delete autotgc-backend >/dev/null 2>&1 || true; pm2 delete autotgc-api autotgc-worker >/dev/null 2>&1 || true; pm2 start deploy/pm2.config.js && pm2 save" 2>&1 | tail -6
sleep 6
echo "=== pm2 list ==="
sudo -u autotgc bash -lc "pm2 list" 2>&1 | grep -E "autotgc-(api|worker)" || true
echo "HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz)"
echo "READYZ=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/readyz)"
echo "READYZ_BODY=$(curl -s http://127.0.0.1:3000/readyz)"
echo "DOCS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/docs/)"
echo "DONE"
