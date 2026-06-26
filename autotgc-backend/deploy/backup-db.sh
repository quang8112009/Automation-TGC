#!/usr/bin/env bash
# AutoTGC — scheduled PostgreSQL backup.
#
# Dumps the app database to a timestamped, gzip-compressed file, prunes old
# backups beyond a retention window, and (optionally) copies the dump off-site.
# Designed to run from cron as root (it sudo-drops to the autotgc user to read
# DATABASE_URL from the app .env, exactly like the deploy script's pre-push
# backup). Safe to run ad-hoc too.
#
# Connection handling mirrors deploy/redeploy2.sh: strip Prisma's `?schema=...`
# query param (libpq pg_dump rejects it) and pick the versioned pg_dump binary
# so the Debian pg_wrapper does not fail on the non-default PG16 port.
#
# Install (root crontab) — daily at 02:30:
#   30 2 * * * /opt/autotgc/deploy/backup-db.sh >> /var/log/autotgc/backup.log 2>&1
#
# Env overrides:
#   BACKUP_DIR        (default /var/backups/autotgc)
#   BACKUP_RETENTION_DAYS (default 14)
#   BACKUP_OFFSITE_DIR    (optional; if set, dumps are also rsync'd here —
#                          point this at a MOUNTED remote/object-storage path)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/autotgc}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/autotgc}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
OFFSITE_DIR="${BACKUP_OFFSITE_DIR:-}"

mkdir -p "${BACKUP_DIR}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/autotgc-${TS}.sql.gz"
ERRLOG="$(mktemp)"

echo "[$(date -Is)] backup starting -> ${OUT}"

# Dump as the autotgc user (it owns .env). Strip the ?schema query param and use
# the highest installed versioned pg_dump. Pipe straight into gzip.
if sudo -u autotgc bash -lc "cd '${APP_DIR}' && set -a && . ./.env && set +a && \
  DUMP_URL=\"\${DATABASE_URL%%\\?*}\" && \
  PGD=\"\$(ls /usr/lib/postgresql/*/bin/pg_dump 2>/dev/null | sort -V | tail -1)\"; \
  \"\${PGD:-pg_dump}\" --no-owner --no-privileges \"\$DUMP_URL\"" 2>"${ERRLOG}" | gzip -9 > "${OUT}"; then
  SIZE="$(wc -c < "${OUT}")"
  if [ "${SIZE}" -lt 100 ]; then
    echo "[$(date -Is)] ERROR: backup file suspiciously small (${SIZE} bytes) — treating as failure"
    cat "${ERRLOG}" || true
    rm -f "${OUT}" "${ERRLOG}"
    exit 1
  fi
  echo "[$(date -Is)] BACKUP_OK ${OUT} (${SIZE} bytes)"
else
  echo "[$(date -Is)] BACKUP_FAILED — see error output:"; tail -5 "${ERRLOG}" || true
  rm -f "${OUT}" "${ERRLOG}"
  exit 1
fi
rm -f "${ERRLOG}"

# Off-site copy (optional). OFFSITE_DIR should be a mounted remote / object store.
if [ -n "${OFFSITE_DIR}" ]; then
  mkdir -p "${OFFSITE_DIR}"
  if cp -f "${OUT}" "${OFFSITE_DIR}/"; then
    echo "[$(date -Is)] off-site copy OK -> ${OFFSITE_DIR}/$(basename "${OUT}")"
  else
    echo "[$(date -Is)] WARNING: off-site copy FAILED (local backup retained)"
  fi
fi

# Prune local backups older than the retention window.
PRUNED="$(find "${BACKUP_DIR}" -name 'autotgc-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
echo "[$(date -Is)] pruned ${PRUNED} backup(s) older than ${RETENTION_DAYS} days"
echo "[$(date -Is)] backup done"
