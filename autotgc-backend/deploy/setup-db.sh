#!/usr/bin/env bash
# Finalize: stop the crash-looping apt redis (reuse existing panel Redis on 6379),
# create the PG16 cluster on a dedicated port, and create the autotgc DB + role.
set -uo pipefail

echo "=== disable conflicting apt redis-server (existing panel redis on 6379 is reused) ==="
systemctl stop redis-server 2>/dev/null || true
systemctl disable redis-server 2>/dev/null || true
systemctl reset-failed redis-server 2>/dev/null || true

echo "=== ensure PG16 cluster exists ==="
if ! pg_lsclusters | awk '{print $1}' | grep -qx 16; then
  # PG14 already holds 5433; give PG16 a dedicated port 5432 (or next free).
  PORT=5432
  if ss -ltn | grep -q ":${PORT} "; then PORT=5434; fi
  pg_createcluster 16 main --port "$PORT" -- --encoding=UTF8 2>&1 | tail -5
fi
pg_ctlcluster 16 main start 2>&1 | tail -3 || systemctl start postgresql@16-main 2>&1 | tail -3
systemctl enable postgresql 2>&1 | tail -1 || true

PG16_PORT="$(pg_lsclusters | awk '$1==16 && $2=="main"{print $3}')"
echo "PG16_PORT=${PG16_PORT}"

echo "=== create role + database (idempotent) ==="
sudo -u postgres psql -p "${PG16_PORT}" -tAc "SELECT 1 FROM pg_roles WHERE rolname='autotgc'" | grep -q 1 || \
  sudo -u postgres psql -p "${PG16_PORT}" -c "CREATE ROLE autotgc LOGIN PASSWORD '${AUTOTGC_DB_PASSWORD}';"
sudo -u postgres psql -p "${PG16_PORT}" -tAc "SELECT 1 FROM pg_database WHERE datname='autotgc'" | grep -q 1 || \
  sudo -u postgres psql -p "${PG16_PORT}" -c "CREATE DATABASE autotgc OWNER autotgc;"

echo "=== FINAL ==="
pg_lsclusters
echo "REDIS_PING=$(redis-cli -h 127.0.0.1 -p 6379 ping 2>&1)"
echo "PG16_PORT=${PG16_PORT}"
echo "DONE"
