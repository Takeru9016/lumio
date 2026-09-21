-- AlterTable
ALTER TABLE "LearningAssignment" ADD COLUMN     "cancellationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastCancelledAt" TIMESTAMP(3),
ADD COLUMN     "lastCancelledById" TEXT,
ADD COLUMN     "lastCancelledByName" TEXT;

-- Backfill: an assignment that is cancelled right now has that cancellation as
-- its history. (Cancellations that were already undone by a reactivation before
-- this migration were erased by the old behaviour and cannot be recovered.)
UPDATE "LearningAssignment" AS a
SET "lastCancelledAt" = a."cancelledAt",
    "lastCancelledById" = a."cancelledById",
    "lastCancelledByName" = (SELECT u."name" FROM "User" AS u WHERE u."id" = a."cancelledById"),
    "cancellationCount" = 1
WHERE a."cancelledAt" IS NOT NULL;
