#!/usr/bin/env bash
# Safe, reversible nginx tweak: enable global gzip_types (covers JSON API
# responses) + gzip_vary, and add a no-cache header to the SPA index.html in the
# two active vhosts. Backs up every file, validates with `nginx -t`, and rolls
# back automatically if validation fails. Never restarts nginx (reload only).
set -uo pipefail

TS="$(date +%Y%m%d-%H%M%S)"
NGINX_CONF="/etc/nginx/nginx.conf"
VHOSTS=(
  "/www/server/panel/vhost/nginx/autotgc.conf"
  "/www/server/panel/vhost/nginx/tgc-auto.conf"
)

backups=()

restore_all() {
  echo "!!! Rolling back from backups"
  for b in "${backups[@]}"; do
    orig="${b%.gzbak-$TS}"
    cp -f "$b" "$orig" && echo "restored $orig"
  done
}

backup() {
  local f="$1"
  local b="${f}.gzbak-${TS}"
  cp -f "$f" "$b"
  backups+=("$b")
  echo "backup: $b"
}

echo "=== 1) Enable global gzip_types + gzip_vary in nginx.conf ==="
backup "$NGINX_CONF"
# Uncomment the stock (commented) gzip tuning lines if present.
sed -i \
  -e 's/^\(\s*\)#\s*gzip_vary on;/\1gzip_vary on;/' \
  -e 's/^\(\s*\)#\s*gzip_proxied any;/\1gzip_proxied any;/' \
  -e 's/^\(\s*\)#\s*gzip_comp_level 6;/\1gzip_comp_level 5;/' \
  -e 's/^\(\s*\)#\s*gzip_types \(.*\)$/\1gzip_types \2/' \
  "$NGINX_CONF"
echo "--- effective gzip lines ---"
grep -nE 'gzip(_vary| on|_proxied|_comp_level|_types)' "$NGINX_CONF" | grep -v '#'

echo "=== 2) Add no-cache header to SPA index.html (location /) in vhosts ==="
for f in "${VHOSTS[@]}"; do
  [ -f "$f" ] || { echo "skip (missing): $f"; continue; }
  if grep -q 'try_files \$uri \$uri/ /index.html;' "$f"; then
    if grep -qE 'no-cache, must-revalidate' "$f"; then
      echo "already has no-cache: $f"
    else
      backup "$f"
      # Insert the header right after the SPA try_files line.
      sed -i 's#\(try_files \$uri \$uri/ /index.html;\)#\1\n        add_header Cache-Control "no-cache, must-revalidate";#' "$f"
      echo "patched no-cache: $f"
    fi
  else
    echo "no SPA try_files in: $f (skipped)"
  fi
done

echo "=== 3) Validate config ==="
if nginx -t 2>&1; then
  echo "=== nginx -t OK -> reload ==="
  if nginx -s reload 2>&1; then
    echo "RELOADED_OK"
  else
    echo "reload failed"; restore_all; nginx -s reload 2>&1; exit 1
  fi
else
  echo "nginx -t FAILED"; restore_all; exit 1
fi

echo "=== 4) Verify ==="
echo "--- /healthz (expect Content-Encoding: gzip now) ---"
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -D - "http://127.0.0.1:8088/healthz" | grep -iE 'content-encoding|content-type'
echo "--- /index.html (expect Cache-Control no-cache) ---"
curl -s -o /dev/null -D - "http://127.0.0.1:8088/" | grep -iE 'cache-control|content-encoding'
echo "--- /assets js (still gzip + immutable) ---"
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -D - "http://127.0.0.1:8088/assets/vendor-react-DcubcOCD.js" | grep -iE 'content-encoding|cache-control'
echo "DONE TS=$TS"
