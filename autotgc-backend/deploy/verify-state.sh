#!/usr/bin/env bash
set -uo pipefail
echo "=== new tables present (expect 3) ==="
sudo -u postgres psql -p 5434 -d autotgc -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('ServiceAccount','ServicePermission','LeadAssignment')"
echo "=== service accounts seeded ==="
sudo -u postgres psql -p 5434 -d autotgc -tAc "SELECT name FROM \"ServiceAccount\" ORDER BY name"
echo "=== service permissions count ==="
sudo -u postgres psql -p 5434 -d autotgc -tAc "SELECT count(*) FROM \"ServicePermission\""
echo "=== app log: workers + scheduler + seeding ==="
grep -i "BullMQ workers started\|Service accounts seeded\|Scheduled jobs started\|queueMode\|Started scheduled job" /var/log/autotgc/out-0.log 2>/dev/null | tail -10
echo "=== any startup errors? ==="
tail -n 6 /var/log/autotgc/err-0.log 2>/dev/null || echo "(err log empty)"
echo "=== rate-limit headers on a request ==="
curl -s -D - -o /dev/null http://127.0.0.1:3000/healthz | grep -i "x-ratelimit\|x-request-id" | head -4
echo "DONE"
