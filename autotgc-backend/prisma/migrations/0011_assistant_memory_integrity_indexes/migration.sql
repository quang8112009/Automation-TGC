-- Assistant memory: referential integrity + hot-path composite indexes.
-- Additive / non-destructive (re-creates indexes; adds a FK).
--
-- 1) FK AssistantConversation.userId -> UserAccount(id) ON DELETE CASCADE so a
--    deleted user's private threads are removed with them (retention / GDPR
--    erasure) and a conversation can never reference a non-existent user.
-- 2) Replace the single-column indexes with composites that serve each hot
--    path's filter AND sort in one index:
--      - AssistantConversation: list = where userId order by updatedAt desc
--      - AssistantMessage:       history = where conversationId order by createdAt

-- DropIndex (superseded by composites; the prefix still covers id-only lookups)
DROP INDEX IF EXISTS "AssistantConversation_userId_idx";
DROP INDEX IF EXISTS "AssistantMessage_conversationId_idx";

-- CreateIndex
CREATE INDEX "AssistantConversation_userId_updatedAt_idx" ON "AssistantConversation"("userId", "updatedAt");
CREATE INDEX "AssistantMessage_conversationId_createdAt_idx" ON "AssistantMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AssistantConversation"
  ADD CONSTRAINT "AssistantConversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
