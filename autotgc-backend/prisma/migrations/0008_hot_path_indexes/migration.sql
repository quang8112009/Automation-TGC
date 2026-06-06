-- Hot-path performance indexes. Additive, NON-destructive.
--
-- Created with CREATE INDEX CONCURRENTLY + IF NOT EXISTS so applying this to a
-- live database does NOT take an ACCESS EXCLUSIVE lock on the table (no write
-- downtime) and is safe to re-run. Index names match Prisma's default naming
-- (`{Table}_{cols}_idx`) so a later `prisma db push` / `migrate` sees the schema
-- as already in sync and never drops or recreates them.
--
-- NOTE: CONCURRENTLY cannot run inside a transaction block. `prisma migrate`
-- wraps each migration in a transaction, so for THIS migration the indexes are
-- created out-of-band by deploy/create-hot-indexes.sh (psql, autocommit). This
-- file documents the canonical DDL and is the source of truth; running it via a
-- plain psql session (not inside BEGIN/COMMIT) is also safe.

-- ScheduledPost: scanDue() runs WHERE status='SCHEDULED' AND scheduledAt<=now
-- ORDER BY scheduledAt — every minute. Composite (status, scheduledAt).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ScheduledPost_status_scheduledAt_idx"
  ON "ScheduledPost" ("status", "scheduledAt");

-- AnalyticsRecord: scoreByPost() reads WHERE publishedPostId ORDER BY collectedAt desc.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AnalyticsRecord_publishedPostId_collectedAt_idx"
  ON "AnalyticsRecord" ("publishedPostId", "collectedAt");

-- PerformanceRecord: feedback loadRecords() filters by scoredAt range.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PerformanceRecord_scoredAt_idx"
  ON "PerformanceRecord" ("scoredAt");

-- PerformanceRecord: insight supporting() filters WHERE contentTopic ORDER BY scoredAt desc.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PerformanceRecord_contentTopic_scoredAt_idx"
  ON "PerformanceRecord" ("contentTopic", "scoredAt");

-- LearningInsight: approval queue reads WHERE insightStatus='PENDING_REVIEW' ORDER BY generatedAt desc.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "LearningInsight_insightStatus_generatedAt_idx"
  ON "LearningInsight" ("insightStatus", "generatedAt");

-- ContentDraft: list() pages ORDER BY createdAt desc; status filter elsewhere.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ContentDraft_createdAt_idx"
  ON "ContentDraft" ("createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ContentDraft_status_idx"
  ON "ContentDraft" ("status");

-- JwtSession: requireAuth + SSE/WS auth look up by sessionId (PK, already indexed);
-- userId FK lookups (session listing / revoke-all) benefit from this index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "JwtSession_userId_idx"
  ON "JwtSession" ("userId");
