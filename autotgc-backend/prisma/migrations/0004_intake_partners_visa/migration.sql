-- Omni-channel Intake + Partners/Destinations + Visa & Logistics (additive).

-- CreateEnum
CREATE TYPE "IntakeChannel" AS ENUM ('FACEBOOK', 'ZALO', 'WEBSITE');
-- CreateEnum
CREATE TYPE "IntakeStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'HANDED_OFF', 'ABANDONED');
-- CreateEnum
CREATE TYPE "IntakeDirection" AS ENUM ('INBOUND', 'OUTBOUND');
-- CreateEnum
CREATE TYPE "PartnerType" AS ENUM ('EMPLOYER', 'SCHOOL', 'BROKER', 'SERVICE');
-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');
-- CreateEnum
CREATE TYPE "DestinationStatus" AS ENUM ('OPEN', 'PAUSED', 'CLOSED');
-- CreateEnum
CREATE TYPE "VisaCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');
-- CreateEnum
CREATE TYPE "VisaTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED');
-- CreateEnum
CREATE TYPE "VisaTaskCategory" AS ENUM ('DOCUMENT', 'INSURANCE', 'FLIGHT', 'HOUSING', 'PICKUP', 'FEE', 'OTHER');

-- CreateTable
CREATE TABLE "IntakeConversation" (
    "id" TEXT NOT NULL,
    "channel" "IntakeChannel" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "flowKey" TEXT NOT NULL DEFAULT 'xkld_default',
    "status" "IntakeStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentFieldKey" TEXT,
    "collected" JSONB NOT NULL DEFAULT '{}',
    "leadId" TEXT,
    "candidateId" TEXT,
    "assignedTo" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntakeConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "IntakeDirection" NOT NULL,
    "text" TEXT NOT NULL,
    "fieldKey" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntakeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerOrg" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PartnerType" NOT NULL DEFAULT 'EMPLOYER',
    "country" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "status" "PartnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PartnerOrg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationProgram" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "visaType" TEXT NOT NULL DEFAULT '',
    "partnerId" TEXT,
    "minAge" INTEGER,
    "maxAge" INTEGER,
    "gender" TEXT NOT NULL DEFAULT 'ANY',
    "requiredLanguage" TEXT NOT NULL DEFAULT '',
    "minLanguageLevel" TEXT NOT NULL DEFAULT '',
    "budgetMinVndM" INTEGER,
    "budgetMaxVndM" INTEGER,
    "industries" JSONB NOT NULL DEFAULT '[]',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "status" "DestinationStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DestinationProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisaCase" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "visaType" TEXT NOT NULL DEFAULT '',
    "status" "VisaCaseStatus" NOT NULL DEFAULT 'OPEN',
    "targetIntakeDate" TIMESTAMP(3),
    "submissionDeadline" TIMESTAMP(3),
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VisaCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisaTask" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "VisaTaskCategory" NOT NULL DEFAULT 'DOCUMENT',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "status" "VisaTaskStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'DEFAULT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VisaTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogisticsPlan" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "flightInfo" JSONB,
    "insuranceType" TEXT NOT NULL DEFAULT '',
    "insuranceInfo" JSONB,
    "pickupService" TEXT NOT NULL DEFAULT '',
    "pickupInfo" JSONB,
    "housingType" TEXT NOT NULL DEFAULT '',
    "housingInfo" JSONB,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LogisticsPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntakeConversation_channel_externalUserId_key" ON "IntakeConversation"("channel", "externalUserId");
CREATE INDEX "IntakeConversation_status_idx" ON "IntakeConversation"("status");
CREATE INDEX "IntakeConversation_candidateId_idx" ON "IntakeConversation"("candidateId");
CREATE INDEX "IntakeConversation_leadId_idx" ON "IntakeConversation"("leadId");
CREATE INDEX "IntakeMessage_conversationId_idx" ON "IntakeMessage"("conversationId");
CREATE INDEX "PartnerOrg_type_idx" ON "PartnerOrg"("type");
CREATE INDEX "PartnerOrg_country_idx" ON "PartnerOrg"("country");
CREATE INDEX "PartnerOrg_status_idx" ON "PartnerOrg"("status");
CREATE INDEX "DestinationProgram_country_idx" ON "DestinationProgram"("country");
CREATE INDEX "DestinationProgram_status_idx" ON "DestinationProgram"("status");
CREATE INDEX "DestinationProgram_active_idx" ON "DestinationProgram"("active");
CREATE INDEX "VisaCase_candidateId_idx" ON "VisaCase"("candidateId");
CREATE INDEX "VisaCase_country_idx" ON "VisaCase"("country");
CREATE INDEX "VisaCase_status_idx" ON "VisaCase"("status");
CREATE INDEX "VisaCase_submissionDeadline_idx" ON "VisaCase"("submissionDeadline");
CREATE INDEX "VisaTask_caseId_idx" ON "VisaTask"("caseId");
CREATE INDEX "VisaTask_status_idx" ON "VisaTask"("status");
CREATE INDEX "VisaTask_dueAt_idx" ON "VisaTask"("dueAt");
CREATE UNIQUE INDEX "LogisticsPlan_caseId_key" ON "LogisticsPlan"("caseId");

-- AddForeignKey
ALTER TABLE "IntakeMessage" ADD CONSTRAINT "IntakeMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "IntakeConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DestinationProgram" ADD CONSTRAINT "DestinationProgram_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "PartnerOrg"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VisaTask" ADD CONSTRAINT "VisaTask_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "VisaCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LogisticsPlan" ADD CONSTRAINT "LogisticsPlan_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "VisaCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
