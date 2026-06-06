#!/usr/bin/env bash
# Re-sync, install, append new env keys, db push (adds new models), build, restart.
set -uo pipefail
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
