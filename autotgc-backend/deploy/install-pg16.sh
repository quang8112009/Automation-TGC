#!/usr/bin/env bash
# Install PostgreSQL 16 alongside the existing PG14 (which stays on its own port).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
CODENAME="$(lsb_release -cs)"
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

apt-get update -y
apt-get install -y postgresql-16

# Ensure Redis and the app user exist (these were skipped when PG16 failed earlier).
systemctl enable --now redis-server
id autotgc >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin autotgc

echo "=== clusters ==="
pg_lsclusters
echo "=== redis ==="
systemctl is-active redis-server
echo "=== user ==="
id autotgc
