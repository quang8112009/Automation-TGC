-- SALES assigned-only ownership for Job Orders. Additive, NON-destructive.
--
-- Adds a nullable `assignedTo` column (consultant userId) to "JobOrder",
-- mirroring "CandidateProfile"."assignedTo", plus a matching lookup index.
-- Existing rows get assignedTo = NULL (unassigned) and are treated as
-- not-owned-by-SALES (fail-closed) by the application layer.

-- AlterTable
ALTER TABLE "JobOrder" ADD COLUMN     "assignedTo" TEXT;

-- CreateIndex
CREATE INDEX "JobOrder_assignedTo_idx" ON "JobOrder"("assignedTo");
