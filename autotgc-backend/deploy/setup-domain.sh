#!/usr/bin/env bash
# Point a real domain at AutoTGC and issue a Let's Encrypt cert.
#
# What it does (idempotent — safe to re-run):
#   1. Renders deploy/domain-vhost.conf for $DOMAIN into nginx sites-available.
#   2. Disables the catch-all :80 site so it can't shadow the domain vhost.
#   3. Obtains/renews a cert with certbot (webroot), then enables HTTPS.
#
# Run as root ON THE SERVER. DNS for $DOMAIN must already resolve to this host's
# public IP (A/AAAA record) BEFORE running — Let's Encrypt validates over :80.
#
# Usage:
#   DOMAIN=app.example.com EMAIL=ops@example.com bash deploy/setup-domain.sh
#   # optional: FRONTEND_DIST=/opt/autotgc-frontend/dist (default)
set -euo pipefail

log() { echo "[setup-domain] $*"; }

: "${DOMAIN:?Set DOMAIN=your.domain.com}"
: "${EMAIL:?Set EMAIL=you@domain.com (for Let's Encrypt expiry notices)}"
FRONTEND_DIST="${FRONTEND_DIST:-/opt/autotgc-frontend/dist}"

# Resolve the template next to this script regardless of the caller's CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/domain-vhost.conf"
[[ -f "${TEMPLATE}" ]] || { echo "missing template: ${TEMPLATE}" >&2; exit 1; }

AVAIL=/etc/nginx/sites-available/autotgc-domain.conf
ENABLED=/etc/nginx/sites-enabled/autotgc-domain.conf

export DEBIAN_FRONTEND=noninteractive

# --- 0. Tooling -------------------------------------------------------------
if ! command -v certbot >/dev/null 2>&1; then
  log "Installing certbot..."
  apt-get update -y
  apt-get install -y certbot
fi
mkdir -p /var/www/html/.well-known/acme-challenge

# --- 1. HTTP-only vhost first (so certbot's webroot challenge can pass) ------
# Render with ONLY our two placeholders; preserve nginx's own $-variables.
log "Rendering vhost for ${DOMAIN} (HTTP bootstrap)..."
DOMAIN="${DOMAIN}" FRONTEND_DIST="${FRONTEND_DIST}" \
  envsubst '${DOMAIN} ${FRONTEND_DIST}' < "${TEMPLATE}" > "${AVAIL}"

# Temporarily strip the HTTPS server block until the cert exists, otherwise
# `nginx -t` fails on the missing certificate files. Cut at the sentinel so the
# preceding HTTP `server { ... }` stays fully balanced.
TMP_HTTP="$(mktemp)"
awk '/__HTTPS_BLOCK__/{exit} {print}' "${AVAIL}" > "${TMP_HTTP}"
# Drop the redirect-to-HTTPS line during bootstrap so the challenge is reachable.
sed -i 's#return 301 https://$host$request_uri;#return 404;#' "${TMP_HTTP}"
install -m 0644 "${TMP_HTTP}" "${AVAIL}"
rm -f "${TMP_HTTP}"

ln -sf "${AVAIL}" "${ENABLED}"
# The default catch-all :80 (server_name _) would otherwise win for unknown
# Host headers; disable it so the domain vhost is authoritative.
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/autotgc.conf 2>/dev/null || true

log "Validating + reloading nginx (HTTP bootstrap)..."
nginx -t
systemctl reload nginx

# --- 2. Issue / renew the certificate ---------------------------------------
log "Requesting Let's Encrypt certificate via webroot..."
certbot certonly \
  --webroot -w /var/www/html \
  -d "${DOMAIN}" \
  --non-interactive --agree-tos -m "${EMAIL}" \
  --keep-until-expiring

# --- 3. Render the full HTTP+HTTPS vhost and reload -------------------------
log "Rendering full vhost (HTTP redirect + HTTPS)..."
DOMAIN="${DOMAIN}" FRONTEND_DIST="${FRONTEND_DIST}" \
  envsubst '${DOMAIN} ${FRONTEND_DIST}' < "${TEMPLATE}" > "${AVAIL}"

log "Validating + reloading nginx (final)..."
nginx -t
systemctl reload nginx

# --- 4. Smoke checks --------------------------------------------------------
sleep 2
log "HTTP_REDIRECT=$(curl -s -o /dev/null -w '%{http_code}' "http://${DOMAIN}/" || true)"
log "HTTPS_SPA=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/" || true)"
log "HTTPS_HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/healthz" || true)"
log "DONE — certbot's systemd timer will auto-renew. Test renewal: certbot renew --dry-run"
