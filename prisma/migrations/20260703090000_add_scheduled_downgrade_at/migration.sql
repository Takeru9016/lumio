-- AlterTable: record the date a cancelled subscription should downgrade to FREE.
-- Nullable, so existing rows need no backfill.
ALTER TABLE "User" ADD COLUMN "scheduledDowngradeAt" TIMESTAMP(3);
