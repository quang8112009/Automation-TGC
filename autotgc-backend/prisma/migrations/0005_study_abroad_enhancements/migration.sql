-- Study-abroad enhancements: Document OCR/verification, scholarship financial
-- fields, behavior-based follow-up. Additive.

-- CreateEnum
CREATE TYPE "DocExtractionStatus" AS ENUM ('PENDING', 'EXTRACTED', 'VERIFIED', 'FAILED', 'NEEDS_RESEND');
-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'CANCELLED');

-- AlterTable: DestinationProgram financial fields (scholarship matching)
ALTER TABLE "DestinationProgram" ADD COLUMN "tuitionPerYearVndM" INTEGER;
ALTER TABLE "DestinationProgram" ADD COLUMN "livingCostPerYearVndM" INTEGER;
ALTER TABLE "DestinationProgram" ADD COLUMN "scholarshipMaxPct" INTEGER;
ALTER TABLE "DestinationProgram" ADD COLUMN "minGpa" DOUBLE PRECISION;
ALTER TABLE "DestinationProgram" ADD COLUMN "minIelts" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "DocumentExtraction" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "checklistItemId" TEXT,
    "docType" TEXT NOT NULL,
    "status" "DocExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT NOT NULL DEFAULT '',
    "extractedFields" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "rawText" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL DEFAULT 'none',
    "verifiedAgainst" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DocumentExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpTask" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "candidateId" TEXT,
    "leadId" TEXT,
    "channel" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "topic" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL DEFAULT '',
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FollowUpTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentExtraction_candidateId_idx" ON "DocumentExtraction"("candidateId");
CREATE INDEX "DocumentExtraction_checklistItemId_idx" ON "DocumentExtraction"("checklistItemId");
CREATE INDEX "DocumentExtraction_status_idx" ON "DocumentExtraction"("status");
CREATE INDEX "FollowUpTask_status_dueAt_idx" ON "FollowUpTask"("status", "dueAt");
CREATE INDEX "FollowUpTask_conversationId_idx" ON "FollowUpTask"("conversationId");
CREATE INDEX "FollowUpTask_externalUserId_idx" ON "FollowUpTask"("externalUserId");
