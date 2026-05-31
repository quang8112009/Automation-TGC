#!/usr/bin/env bash
# Re-sync source into /opt/autotgc, reinstall deps, db push (idempotent), build, restart PM2.
set -uo pipefail
APP_DIR=/opt/autotgc
SRC_DIR=/opt/autotgc-src

echo "=== sync (preserve .env) ==="
rsync -a --delete --exclude node_modules --exclude .env --exclude media "${SRC_DIR}/" "${APP_DIR}/"
chown -R autotgc:autotgc "${APP_DIR}"

cd "${APP_DIR}"
echo "=== install deps ==="
sudo -u autotgc bash -lc "cd ${APP_DIR} && npm install --no-audit --no-fund 2>&1 | tail -3"

echo "=== prisma generate + db push ==="
sudo -u autotgc bash -lc "cd ${APP_DIR} && npx prisma generate 2>&1 | tail -2 && npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -6"

echo "=== build ==="
sudo -u autotgc bash -lc "cd ${APP_DIR} && npm run build 2>&1 | tail -5"

echo "=== restart ==="
sudo -u autotgc bash -lc "cd ${APP_DIR} && pm2 restart autotgc-backend 2>&1 | tail -3"
sleep 4
echo "HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz)"
echo "=== recent app errors (if any) ==="
tail -n 8 /var/log/autotgc/err.log 2>/dev/null || true
echo "DONE"
