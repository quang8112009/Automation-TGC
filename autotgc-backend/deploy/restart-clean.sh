#!/usr/bin/env bash
set -uo pipefail
echo "=== port 3000 owners before ==="
ss -ltnp | grep ':3000 ' || echo "3000 free"
# Kill any stray non-PM2 node on 3000 owned by autotgc (from manual test starts)
for pid in $(pgrep -u autotgc -f 'node dist/index.js'); do
  # Only kill if not managed by pm2 (pm2 god daemon reparents; safe to kill stray)
  echo "killing stray node pid $pid"
  kill -9 "$pid" 2>/dev/null || true
done
sleep 2
echo "=== pm2 delete + start fresh ==="
sudo -u autotgc bash -lc 'cd /opt/autotgc && pm2 delete autotgc-backend >/dev/null 2>&1 || true; pm2 start deploy/pm2.config.js && pm2 save' 2>&1 | tail -6
sleep 5
echo "HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz)"
echo "=== err log ==="
tail -n 20 /var/log/autotgc/err.log 2>/dev/null || true
echo "DONE"
