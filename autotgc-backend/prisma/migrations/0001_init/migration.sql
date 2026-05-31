-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'SALES');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('NEW', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "UserAccount" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ADMIN',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JwtSession" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "accessExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "JwtSession_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "PlatformToken" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "refreshWindowSeconds" INTEGER NOT NULL DEFAULT 86400,
    "status" TEXT NOT NULL DEFAULT 'VALID',
    "lastRefreshFailureReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainContext" (
    "id" TEXT NOT NULL,
    "domainName" TEXT NOT NULL,
    "contextDescription" TEXT NOT NULL DEFAULT '',
    "defaultToneOfVoice" TEXT NOT NULL DEFAULT 'friendly',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPersona" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "personaName" TEXT NOT NULL,
    "age" TEXT NOT NULL,
    "interests" TEXT NOT NULL DEFAULT '',
    "targetNeeds" TEXT NOT NULL,
    "painPoints" TEXT NOT NULL,
    "toneOfVoice" TEXT NOT NULL,
    "recommendedTone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPersona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentDraft" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedWithoutFeedback" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "previewPresented" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftCta" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "ctaText" TEXT NOT NULL,

    CONSTRAINT "DraftCta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "idempotencyKey" TEXT NOT NULL,
    "externalPostId" TEXT,
    "postUrl" TEXT,
    "errorCode" TEXT,
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsRecord" (
    "id" TEXT NOT NULL,
    "publishedPostId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "views" INTEGER,
    "likes" INTEGER,
    "shares" INTEGER,
    "comments" INTEGER,
    "follows" INTEGER,
    "leads" INTEGER,
    "clickThrough" INTEGER,
    "reach" INTEGER,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceRecord" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "domainCategory" TEXT NOT NULL,
    "contentTopic" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "toneOfVoice" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "postTimeSlot" TEXT NOT NULL,
    "contentLength" INTEGER NOT NULL,
    "hasCta" BOOLEAN NOT NULL,
    "ctaType" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "conversionRate" DOUBLE PRECISION NOT NULL,
    "engagementRate" DOUBLE PRECISION NOT NULL,
    "ctaClickRate" DOUBLE PRECISION NOT NULL,
    "followRate" DOUBLE PRECISION,
    "performanceLabel" TEXT NOT NULL,
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningInsight" (
    "id" TEXT NOT NULL,
    "insightType" TEXT NOT NULL,
    "insightStatus" "InsightStatus" NOT NULL DEFAULT 'NEW',
    "subject" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "recommendedChange" JSONB NOT NULL,
    "modifiedChange" JSONB,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "analysisPeriod" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPromptContext" (
    "id" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "lastUpdatedFromAnalytics" TIMESTAMP(3),
    "topPerformingTopics" JSONB NOT NULL,
    "bestCtaPatterns" JSONB NOT NULL,
    "avoidTopics" JSONB NOT NULL,
    "optimalContentLength" JSONB NOT NULL,
    "toneRecommendations" JSONB NOT NULL,
    "optimalSchedules" JSONB NOT NULL,

    CONSTRAINT "AiPromptContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "insightId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "leadId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "source" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "contentPostId" TEXT NOT NULL,
    "domainCategory" TEXT,
    "contentTopic" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "note" TEXT,
    "assignedTo" TEXT,
    "unattributed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("leadId")
);

-- CreateTable
CREATE TABLE "LeadHistoryEntry" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "note" TEXT,
    "assignedTo" TEXT,
    "actor" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenAlert" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePermission" (
    "id" TEXT NOT NULL,
    "serviceAccountId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,

    CONSTRAINT "ServicePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadAssignment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAccount_username_key" ON "UserAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformToken_platform_key" ON "PlatformToken"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "DomainContext_domainName_key" ON "DomainContext"("domainName");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPost_idempotencyKey_key" ON "ScheduledPost"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPost_platform_idempotencyKey_key" ON "ScheduledPost"("platform", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Lead_source_idx" ON "Lead"("source");

-- CreateIndex
CREATE INDEX "Lead_platform_idx" ON "Lead"("platform");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");

-- CreateIndex
CREATE INDEX "Lead_contentPostId_idx" ON "Lead"("contentPostId");

-- CreateIndex
CREATE INDEX "Lead_domainCategory_contentTopic_idx" ON "Lead"("domainCategory", "contentTopic");

-- CreateIndex
CREATE INDEX "Lead_assignedTo_idx" ON "Lead"("assignedTo");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_name_key" ON "ServiceAccount"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePermission_serviceAccountId_module_action_key" ON "ServicePermission"("serviceAccountId", "module", "action");

-- CreateIndex
CREATE UNIQUE INDEX "LeadAssignment_leadId_key" ON "LeadAssignment"("leadId");

-- CreateIndex
CREATE INDEX "LeadAssignment_userId_idx" ON "LeadAssignment"("userId");

-- AddForeignKey
ALTER TABLE "JwtSession" ADD CONSTRAINT "JwtSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPersona" ADD CONSTRAINT "ContentPersona_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "DomainContext"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "DomainContext"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "ContentPersona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftCta" ADD CONSTRAINT "DraftCta_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadHistoryEntry" ADD CONSTRAINT "LeadHistoryEntry_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("leadId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePermission" ADD CONSTRAINT "ServicePermission_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

