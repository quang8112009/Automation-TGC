-- Assistant conversational memory + semantic-retrieval embedding cache.
-- Additive, NON-destructive.
--
-- 1) Adds a nullable `embedding` jsonb column to "KnowledgeEntry" caching each
--    entry's embedding vector (number[]) for semantic (cosine) retrieval. NULL
--    until an ADMIN reindex computes it; absent it, retrieval falls back to the
--    deterministic keyword/tag ranking. Existing rows get embedding = NULL.
-- 2) Adds the assistant conversation memory tables so the grounded assistant can
--    carry multi-turn context. Conversations are private to their owner user
--    (no FK to "UserAccount" is enforced here to keep the column owner-agnostic
--    and avoid coupling deletes; the application layer scopes by userId).

-- AlterTable
ALTER TABLE "KnowledgeEntry" ADD COLUMN     "embedding" JSONB;

-- CreateEnum
CREATE TYPE "AssistantRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "AssistantConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AssistantRole" NOT NULL,
    "content" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantConversation_userId_idx" ON "AssistantConversation"("userId");

-- CreateIndex
CREATE INDEX "AssistantMessage_conversationId_idx" ON "AssistantMessage"("conversationId");

-- AddForeignKey
ALTER TABLE "AssistantMessage" ADD CONSTRAINT "AssistantMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
