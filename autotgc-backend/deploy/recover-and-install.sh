#!/usr/bin/env bash
# Recover a wedged apt/dpkg (hung on needrestart prompt), then install PG16 + Redis + app user.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

echo "=== killing stuck apt/dpkg processes ==="
pkill -9 -f 'apt-get install' 2>/dev/null || true
pkill -9 -f 'dpkg --configure' 2>/dev/null || true
pkill -9 -f 'needrestart' 2>/dev/null || true
sleep 3

echo "=== disabling needrestart interactive prompts ==="
if [ -f /etc/needrestart/needrestart.conf ]; then
  sed -i "s/^#\?\s*\$nrconf{restart}.*/\$nrconf{restart} = 'a';/" /etc/needrestart/needrestart.conf || true
fi

echo "=== clearing locks ==="
rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock 2>/dev/null || true

echo "=== dpkg --configure -a ==="
dpkg --configure -a 2>&1 | tail -5
echo "DPKG_CONFIGURE_EXIT=$?"

echo "=== apt-get -f install (fix broken) ==="
apt-get -f install -y 2>&1 | tail -5

echo "=== finish base packages from provision ==="
apt-get install -y curl ca-certificates gnupg lsb-release ufw nginx redis-server 2>&1 | tail -5

echo "=== install postgresql-16 ==="
apt-get update -y 2>&1 | tail -3
apt-get install -y postgresql-16 2>&1 | tail -8

echo "=== enable services + app user ==="
systemctl enable --now redis-server 2>&1 | tail -2
systemctl enable --now postgresql 2>&1 | tail -2
id autotgc >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin autotgc

echo "=== FINAL STATE ==="
pg_lsclusters
echo "REDIS=$(systemctl is-active redis-server)"
echo "PG16BIN=$(ls /usr/lib/postgresql/16/bin/psql 2>/dev/null || echo MISSING)"
id autotgc 2>&1
echo "NODE=$(node -v)"
echo "DONE"
