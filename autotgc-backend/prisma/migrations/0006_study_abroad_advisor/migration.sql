-- Study-abroad AI advisor suite: admissions scoring, SOP/essay drafts, visa
-- interview-prep sessions, application timeline cases + reminders, and roadmap
-- narratives. Fully additive (CREATE TYPE / CREATE TABLE / CREATE INDEX /
-- ADD CONSTRAINT / ALTER TABLE ADD COLUMN only — no DROP, no type changes).
-- DestinationProgram financial/academic columns from 0005 are NOT re-added.

-- CreateEnum
CREATE TYPE "EssayDocType" AS ENUM ('SOP', 'MOTIVATION', 'CV');

-- CreateEnum
CREATE TYPE "EssayStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PLANNING', 'SUBMITTED', 'OFFER', 'VISA', 'ENROLLED', 'WITHDRAWN', 'REJECTED');

-- AlterTable: DestinationProgram additive admissions thresholds (nullable, no default)
ALTER TABLE "DestinationProgram" ADD COLUMN "minToefl" INTEGER;
ALTER TABLE "DestinationProgram" ADD COLUMN "minJlpt" TEXT;
ALTER TABLE "DestinationProgram" ADD COLUMN "selectivityTier" TEXT;

-- CreateTable
CREATE TABLE "AcademicProfile" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "gpa" DOUBLE PRECISION,
    "gpaScale" DOUBLE PRECISION,
    "ielts" DOUBLE PRECISION,
    "toefl" INTEGER,
    "jlpt" TEXT,
    "educationLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademicProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EssayDraft" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "docType" "EssayDocType" NOT NULL,
    "programId" TEXT,
    "content" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "status" "EssayStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EssayDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewSession" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "visaType" TEXT NOT NULL DEFAULT '',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "feedback" JSONB NOT NULL DEFAULT '{}',
    "score" DOUBLE PRECISION,
    "assignedAtCreation" TEXT,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationCase" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "programId" TEXT,
    "intakeLabel" TEXT NOT NULL,
    "targetIntakeDate" TIMESTAMP(3),
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PLANNING',
    "visaCaseId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDueItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'DOCUMENT',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationDueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "dueItemId" TEXT NOT NULL,
    "dueItemType" TEXT NOT NULL DEFAULT 'APPLICATION',
    "windowKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoadmapNarrative" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "programId" TEXT,
    "estimate" JSONB NOT NULL,
    "narrative" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "status" "EssayStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoadmapNarrative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcademicProfile_candidateId_key" ON "AcademicProfile"("candidateId");

-- CreateIndex
CREATE INDEX "AcademicProfile_candidateId_idx" ON "AcademicProfile"("candidateId");

-- CreateIndex
CREATE INDEX "EssayDraft_candidateId_idx" ON "EssayDraft"("candidateId");

-- CreateIndex
CREATE INDEX "EssayDraft_status_idx" ON "EssayDraft"("status");

-- CreateIndex
CREATE INDEX "InterviewSession_candidateId_idx" ON "InterviewSession"("candidateId");

-- CreateIndex
CREATE INDEX "ApplicationCase_candidateId_idx" ON "ApplicationCase"("candidateId");

-- CreateIndex
CREATE INDEX "ApplicationCase_status_idx" ON "ApplicationCase"("status");

-- CreateIndex
CREATE INDEX "ApplicationDueItem_caseId_idx" ON "ApplicationDueItem"("caseId");

-- CreateIndex
CREATE INDEX "ApplicationDueItem_dueAt_idx" ON "ApplicationDueItem"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_dueItemId_windowKey_key" ON "ReminderLog"("dueItemId", "windowKey");

-- CreateIndex
CREATE INDEX "ReminderLog_status_idx" ON "ReminderLog"("status");

-- CreateIndex
CREATE INDEX "RoadmapNarrative_candidateId_idx" ON "RoadmapNarrative"("candidateId");

-- CreateIndex
CREATE INDEX "RoadmapNarrative_status_idx" ON "RoadmapNarrative"("status");

-- AddForeignKey
ALTER TABLE "AcademicProfile" ADD CONSTRAINT "AcademicProfile_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EssayDraft" ADD CONSTRAINT "EssayDraft_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationCase" ADD CONSTRAINT "ApplicationCase_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDueItem" ADD CONSTRAINT "ApplicationDueItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ApplicationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoadmapNarrative" ADD CONSTRAINT "RoadmapNarrative_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
