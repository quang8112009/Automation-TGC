#!/usr/bin/env bash
set -uo pipefail
cd /opt/autotgc
echo "=== prisma db push (as autotgc) ==="
sudo -u autotgc bash -lc 'cd /opt/autotgc && npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -15'
echo "=== table count ==="
sudo -u postgres psql -p 5434 -d autotgc -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
echo "=== restart app ==="
sudo -u autotgc bash -lc 'pm2 restart autotgc-backend 2>&1 | tail -3'
sleep 3
echo "HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz)"
echo "DONE"
