#!/usr/bin/env bash
# Build + install the app into /opt/autotgc, write .env (600, autotgc-owned),
# run migrations, and (re)start under PM2 as the autotgc user.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

APP_DIR=/opt/autotgc
SRC_DIR=/opt/autotgc-src

echo "=== sync source into ${APP_DIR} ==="
mkdir -p "${APP_DIR}"
rsync -a --delete --exclude node_modules --exclude .env "${SRC_DIR}/" "${APP_DIR}/"
mkdir -p /var/log/autotgc
chown -R autotgc:autotgc "${APP_DIR}" /var/log/autotgc

echo "=== install deps (incl dev for build) ==="
cd "${APP_DIR}"
npm install --no-audit --no-fund 2>&1 | tail -4

echo "=== write .env (perms 600, owned by autotgc) ==="
cat > "${APP_DIR}/.env" <<EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATABASE_URL=postgresql://autotgc:${AUTOTGC_DB_PASSWORD}@127.0.0.1:${PG16_PORT}/autotgc?schema=public
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=${JWT_SECRET}
ACCESS_TOKEN_TTL_HOURS=24
REFRESH_TOKEN_TTL_DAYS=30
LOCKOUT_THRESHOLD=5
FRONTEND_ORIGIN=*
WEBHOOK_SECRET_FACEBOOK=${WH_FB}
WEBHOOK_SECRET_WEBSITE=${WH_WEB}
SYNC_STALENESS_HOURS=6
EOF
chmod 600 "${APP_DIR}/.env"
chown autotgc:autotgc "${APP_DIR}/.env"

echo "=== prisma generate + migrate ==="
cd "${APP_DIR}"
npx prisma generate 2>&1 | tail -3
# First deploy: create the schema from the Prisma models.
npx prisma migrate deploy 2>&1 | tail -8 || {
  echo "migrate deploy found no migrations; using db push to create schema";
  npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -8;
}

echo "=== build ==="
npm run build 2>&1 | tail -5

echo "=== start under PM2 as autotgc ==="
# Run PM2 as the autotgc user so the app is never root (Req 14).
sudo -u autotgc bash -lc "cd ${APP_DIR} && pm2 delete autotgc-backend >/dev/null 2>&1 || true; pm2 start deploy/pm2.config.js && pm2 save" 2>&1 | tail -8

echo "=== configure nginx reverse proxy ==="
cp "${APP_DIR}/deploy/nginx-autotgc.conf" /etc/nginx/sites-available/autotgc.conf
ln -sf /etc/nginx/sites-available/autotgc.conf /etc/nginx/sites-enabled/autotgc.conf
# Remove default site if it would conflict on :80 default_server.
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t 2>&1 | tail -4 && systemctl reload nginx 2>&1 | tail -2

echo "=== HEALTH CHECK ==="
sleep 3
echo "LOCAL_HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz)"
echo "VIA_NGINX=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/healthz)"
echo "DONE"
