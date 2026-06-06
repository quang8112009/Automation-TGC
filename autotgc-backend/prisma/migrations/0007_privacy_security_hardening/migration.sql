-- Privacy, consent & webhook-replay hardening. Fully additive (CREATE TYPE /
-- CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX / ALTER TABLE ADD COLUMN
-- only — no DROP, no type changes, no data rewrite).

-- AlterTable: time-boxed lockout recovery (nullable, no default) on UserAccount
ALTER TABLE "UserAccount" ADD COLUMN "lockedUntil" TIMESTAMP(3);

-- AlterTable: per-delivery idempotency key on Lead (nullable, unique below)
ALTER TABLE "Lead" ADD COLUMN "dedupKey" TEXT;

-- CreateUniqueIndex: replayed webhook -> existing Lead (upsert no-op)
CREATE UNIQUE INDEX "Lead_dedupKey_key" ON "Lead"("dedupKey");

-- CreateEnum
CREATE TYPE "ConsentSubjectType" AS ENUM ('LEAD', 'CANDIDATE', 'INTAKE');

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('DATA_PROCESSING', 'MARKETING', 'CROSS_BORDER_AI');

-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ErasureStatus" AS ENUM ('REQUESTED', 'COMPLETED', 'REJECTED');

-- CreateTable: inbound webhook replay ledger
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "signature" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "WebhookDelivery_source_deliveryId_key" ON "WebhookDelivery"("source", "deliveryId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");

-- CreateTable: append-only consent ledger
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "subjectType" "ConsentSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "action" "ConsentAction" NOT NULL DEFAULT 'GRANTED',
    "source" TEXT NOT NULL DEFAULT '',
    "note" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_subjectType_subjectId_idx" ON "ConsentRecord"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ConsentRecord_scope_idx" ON "ConsentRecord"("scope");

-- CreateIndex
CREATE INDEX "ConsentRecord_recordedAt_idx" ON "ConsentRecord"("recordedAt");

-- CreateTable: right-to-erasure request + outcome
CREATE TABLE "ErasureRequest" (
    "id" TEXT NOT NULL,
    "subjectType" "ConsentSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" "ErasureStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL DEFAULT '',
    "requestedBy" TEXT NOT NULL,
    "processedBy" TEXT,
    "erasedSummary" JSONB NOT NULL DEFAULT '{}',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ErasureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErasureRequest_subjectType_subjectId_idx" ON "ErasureRequest"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ErasureRequest_status_idx" ON "ErasureRequest"("status");
