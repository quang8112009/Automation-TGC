#!/usr/bin/env bash
# Configure the AutoTGC domain on an aaPanel/BT Panel server (panel nginx tree).
# Idempotent. Run as root ON THE SERVER.
#
# Stage controlled by ACTION:
#   ACTION=http   -> install/refresh the HTTP vhost for $DOMAIN (default)
#   ACTION=cert   -> issue cert via acme.sh (webroot) then add HTTPS + redirect
#   ACTION=status -> show current vhost + resolve + curl checks
#
# Required env: DOMAIN. For ACTION=cert also EMAIL.
#   DOMAIN=tgc-auto.example.com EMAIL=admin@example.com ACTION=cert bash setup-domain-panel.sh
set -uo pipefail

log() { echo "[setup-domain-panel] $*"; }

: "${DOMAIN:?Set DOMAIN=your.domain}"
ACTION="${ACTION:-http}"
FRONTEND_DIST="${FRONTEND_DIST:-/opt/autotgc-frontend/dist}"

PANEL_VHOST_DIR=/www/server/panel/vhost/nginx
VHOST="${PANEL_VHOST_DIR}/tgc-auto.conf"
NGINX_BIN=/www/server/nginx/sbin/nginx
WEBROOT=/var/www/html
CERT_DIR="/www/server/panel/vhost/cert/${DOMAIN}"

reload_nginx() {
  if "${NGINX_BIN}" -t 2>&1 | tail -2; then
    /etc/init.d/nginx reload 2>/dev/null || "${NGINX_BIN}" -s reload
    log "nginx reloaded."
  else
    log "ERROR: nginx config test failed; NOT reloading."
    return 1
  fi
}

write_http_vhost() {
  mkdir -p "${WEBROOT}/.well-known/acme-challenge"
  cat > "${VHOST}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root ${FRONTEND_DIST};
    index index.html;

    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type "text/plain";
        try_files \$uri =404;
    }

    location /assets/ {
        try_files \$uri =404;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    location /api/v1/ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    location = /api/v1/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
    location = /api/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    location /healthz { proxy_pass http://127.0.0.1:3000; }
    location /readyz  { proxy_pass http://127.0.0.1:3000; }
    location /docs    { proxy_pass http://127.0.0.1:3000; }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX
  log "Wrote HTTP vhost -> ${VHOST}"
}

write_https_vhost() {
  mkdir -p "${WEBROOT}/.well-known/acme-challenge"
  cat > "${VHOST}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type "text/plain";
        try_files \$uri =404;
    }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;
    add_header Strict-Transport-Security "max-age=31536000" always;

    root ${FRONTEND_DIST};
    index index.html;

    location /assets/ {
        try_files \$uri =404;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    location /api/v1/ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    location = /api/v1/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
    location = /api/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    location /healthz { proxy_pass http://127.0.0.1:3000; }
    location /readyz  { proxy_pass http://127.0.0.1:3000; }
    location /docs    { proxy_pass http://127.0.0.1:3000; }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX
  log "Wrote HTTPS vhost -> ${VHOST}"
}

ensure_acme() {
  if [[ -x /root/.acme.sh/acme.sh ]]; then return 0; fi
  log "Installing acme.sh..."
  curl -fsSL https://get.acme.sh | sh -s email="${EMAIL:?Set EMAIL for cert issuance}" >/dev/null 2>&1 || true
  [[ -x /root/.acme.sh/acme.sh ]]
}

case "${ACTION}" in
  http)
    write_http_vhost
    reload_nginx
    log "DNS check from server:"; getent hosts "${DOMAIN}" || log "  ${DOMAIN} does NOT resolve yet (create the A record)."
    ;;
  cert)
    : "${EMAIL:?Set EMAIL=you@domain for Lets Encrypt}"
    # Make sure the HTTP vhost + webroot are in place for the challenge.
    write_http_vhost
    reload_nginx
    if ! getent hosts "${DOMAIN}" >/dev/null; then
      log "ABORT: ${DOMAIN} does not resolve. Create the A record to 36.50.26.118 first."
      exit 2
    fi
    ensure_acme || { log "acme.sh install failed"; exit 1; }
    /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
    log "Issuing certificate via webroot..."
    /root/.acme.sh/acme.sh --issue -d "${DOMAIN}" -w "${WEBROOT}" --keylength ec-256 || {
      log "Issue failed. Check that http://${DOMAIN}/.well-known/acme-challenge/ is reachable."; exit 1; }
    mkdir -p "${CERT_DIR}"
    /root/.acme.sh/acme.sh --install-cert -d "${DOMAIN}" --ecc \
      --key-file       "${CERT_DIR}/privkey.pem" \
      --fullchain-file "${CERT_DIR}/fullchain.pem" \
      --reloadcmd      "/etc/init.d/nginx reload 2>/dev/null || ${NGINX_BIN} -s reload"
    write_https_vhost
    reload_nginx
    ;;
  status)
    echo "--- vhost ${VHOST} ---"; cat "${VHOST}" 2>&1 | head -40
    echo "--- resolve ---"; getent hosts "${DOMAIN}" || echo "no-resolve"
    echo "--- curl http ---"; curl -s -o /dev/null -w "%{http_code}\n" "http://${DOMAIN}/healthz" || true
    echo "--- curl https ---"; curl -sk -o /dev/null -w "%{http_code}\n" "https://${DOMAIN}/healthz" || true
    ;;
  *)
    log "Unknown ACTION=${ACTION} (use http|cert|status)"; exit 1;;
esac

log "DONE (ACTION=${ACTION})."
