#!/usr/bin/env bash
# Safely create the hot-path indexes on the LIVE Postgres (port 5434) WITHOUT a
# write lock, after taking a schema-only + data backup. Idempotent: re-running
# is a no-op (CREATE INDEX CONCURRENTLY IF NOT EXISTS). Names match Prisma's
# default convention so a later `prisma db push` treats them as already in sync.
#
# Run as root on the server: bash /tmp/create-hot-indexes.sh
set -uo pipefail

PGPORT=5434
DB=autotgc
PSQL="sudo -u postgres psql -p ${PGPORT} -d ${DB} -v ON_ERROR_STOP=1"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=/var/backups/autotgc
mkdir -p "${BACKUP_DIR}"
# pg_dump runs as the 'postgres' OS user, so the dir must be writable by it.
chown postgres:postgres "${BACKUP_DIR}" 2>/dev/null || true
chmod 770 "${BACKUP_DIR}" 2>/dev/null || true

echo "=== 1) BACKUP (custom-format dump) -> ${BACKUP_DIR}/autotgc-${TS}.dump ==="
if sudo -u postgres pg_dump -p ${PGPORT} -Fc -d ${DB} -f "${BACKUP_DIR}/autotgc-${TS}.dump"; then
  ls -la "${BACKUP_DIR}/autotgc-${TS}.dump"
else
  echo "!!! BACKUP FAILED — aborting, no index changes made."
  exit 1
fi

echo "=== 2) row counts (context for expected index build time) ==="
sudo -u postgres psql -p ${PGPORT} -d ${DB} -tAc "
  SELECT 'ScheduledPost', count(*) FROM \"ScheduledPost\"
  UNION ALL SELECT 'AnalyticsRecord', count(*) FROM \"AnalyticsRecord\"
  UNION ALL SELECT 'PerformanceRecord', count(*) FROM \"PerformanceRecord\"
  UNION ALL SELECT 'LearningInsight', count(*) FROM \"LearningInsight\"
  UNION ALL SELECT 'ContentDraft', count(*) FROM \"ContentDraft\"
  UNION ALL SELECT 'JwtSession', count(*) FROM \"JwtSession\";"

echo "=== 3) CREATE INDEX CONCURRENTLY (lock-free, idempotent) ==="
# Each statement runs in its own autocommit psql call (CONCURRENTLY cannot run
# inside a transaction block).
run_idx() {
  echo "--- $1"
  sudo -u postgres psql -p ${PGPORT} -d ${DB} -c "$2" 2>&1 | tail -2
}
run_idx "ScheduledPost(status,scheduledAt)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ScheduledPost_status_scheduledAt_idx" ON "ScheduledPost" ("status","scheduledAt");'
run_idx "AnalyticsRecord(publishedPostId,collectedAt)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "AnalyticsRecord_publishedPostId_collectedAt_idx" ON "AnalyticsRecord" ("publishedPostId","collectedAt");'
run_idx "PerformanceRecord(scoredAt)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "PerformanceRecord_scoredAt_idx" ON "PerformanceRecord" ("scoredAt");'
run_idx "PerformanceRecord(contentTopic,scoredAt)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "PerformanceRecord_contentTopic_scoredAt_idx" ON "PerformanceRecord" ("contentTopic","scoredAt");'
run_idx "LearningInsight(insightStatus,generatedAt)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "LearningInsight_insightStatus_generatedAt_idx" ON "LearningInsight" ("insightStatus","generatedAt");'
run_idx "ContentDraft(createdAt)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ContentDraft_createdAt_idx" ON "ContentDraft" ("createdAt");'
run_idx "ContentDraft(status)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ContentDraft_status_idx" ON "ContentDraft" ("status");'
run_idx "JwtSession(userId)" \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "JwtSession_userId_idx" ON "JwtSession" ("userId");'

echo "=== 4) VERIFY: any INVALID index (failed concurrent build)? ==="
sudo -u postgres psql -p ${PGPORT} -d ${DB} -tAc "
  SELECT c.relname FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE NOT i.indisvalid;" | sed 's/^/INVALID: /' || true

echo "=== 5) VERIFY: the 8 expected indexes now exist ==="
sudo -u postgres psql -p ${PGPORT} -d ${DB} -tAc "
  SELECT indexname FROM pg_indexes
  WHERE schemaname='public' AND indexname IN (
    'ScheduledPost_status_scheduledAt_idx',
    'AnalyticsRecord_publishedPostId_collectedAt_idx',
    'PerformanceRecord_scoredAt_idx',
    'PerformanceRecord_contentTopic_scoredAt_idx',
    'LearningInsight_insightStatus_generatedAt_idx',
    'ContentDraft_createdAt_idx',
    'ContentDraft_status_idx',
    'JwtSession_userId_idx'
  ) ORDER BY indexname;"
echo "DONE"
