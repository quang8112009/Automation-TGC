#!/usr/bin/env bash
# Server provisioning for AutoTGC backend (Ubuntu 22.04).
# Idempotent: safe to re-run. Run as root.
set -euo pipefail

log() { echo "[provision] $*"; }

export DEBIAN_FRONTEND=noninteractive

log "Updating apt and installing base packages..."
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release ufw nginx redis-server

# --- Node.js 20 LTS ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | cut -d. -f1)" != "v20" ]]; then
  log "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "Node: $(node -v), npm: $(npm -v)"

# --- PM2 --------------------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing PM2..."
  npm install -g pm2
fi

# --- PostgreSQL 16 ----------------------------------------------------------
if ! command -v psql >/dev/null 2>&1 || ! psql --version | grep -q ' 16'; then
  log "Installing PostgreSQL 16..."
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-16
fi
systemctl enable --now postgresql
systemctl enable --now redis-server

# --- Application user (least privilege, no login shell for SSH) -------------
if ! id autotgc >/dev/null 2>&1; then
  log "Creating least-privilege application user 'autotgc'..."
  useradd --system --create-home --shell /usr/sbin/nologin autotgc
fi

log "Provisioning base complete."
