-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'ARCHIVED', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "DocSubmissionStatus" AS ENUM ('PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocSource" AS ENUM ('DEFAULT', 'CUSTOM');

-- AlterTable
ALTER TABLE "ContentDraft" ADD COLUMN     "priorityIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "LearningInsight" ADD COLUMN     "priorityIndex" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CompanyReport" (
    "id" TEXT NOT NULL,
    "reportType" "ReportType" NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "scopeUserId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChecklistItem" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "DocSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "source" "DocSource" NOT NULL DEFAULT 'DEFAULT',
    "note" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTypeCatalog" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "docs" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTypeCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyReport_reportType_periodFrom_idx" ON "CompanyReport"("reportType", "periodFrom");

-- CreateIndex
CREATE INDEX "CompanyReport_status_idx" ON "CompanyReport"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyReport_reportType_periodLabel_scopeUserId_key" ON "CompanyReport"("reportType", "periodLabel", "scopeUserId");

-- CreateIndex
CREATE INDEX "DocumentChecklistItem_candidateId_idx" ON "DocumentChecklistItem"("candidateId");

-- CreateIndex
CREATE INDEX "DocumentChecklistItem_status_idx" ON "DocumentChecklistItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTypeCatalog_market_key" ON "DocumentTypeCatalog"("market");

-- AddForeignKey
ALTER TABLE "DocumentChecklistItem" ADD CONSTRAINT "DocumentChecklistItem_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
