-- CreateEnum
CREATE TYPE "AssignmentSource" AS ENUM ('MANUAL', 'MANDATORY', 'CAPABILITY_GAP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'LEARNING_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'LEARNING_DUE_SOON';
ALTER TYPE "NotificationType" ADD VALUE 'LEARNING_OVERDUE';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT;

-- AlterTable
ALTER TABLE "MandatoryTraining" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "createdById" TEXT;

-- CreateTable
CREATE TABLE "LearningAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "source" "AssignmentSource" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "reason" JSONB NOT NULL,
    "dueDate" TIMESTAMP(3),
    "mandatoryTrainingId" TEXT,
    "assignedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LearningAssignment_tenantId_cancelledAt_dueDate_idx" ON "LearningAssignment"("tenantId", "cancelledAt", "dueDate");

-- CreateIndex
CREATE INDEX "LearningAssignment_userId_cancelledAt_idx" ON "LearningAssignment"("userId", "cancelledAt");

-- CreateIndex
CREATE INDEX "LearningAssignment_courseId_idx" ON "LearningAssignment"("courseId");

-- CreateIndex
CREATE INDEX "LearningAssignment_mandatoryTrainingId_idx" ON "LearningAssignment"("mandatoryTrainingId");

-- CreateIndex
CREATE UNIQUE INDEX "LearningAssignment_userId_courseId_source_sourceKey_key" ON "LearningAssignment"("userId", "courseId", "source", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "MandatoryTraining" ADD CONSTRAINT "MandatoryTraining_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningAssignment" ADD CONSTRAINT "LearningAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningAssignment" ADD CONSTRAINT "LearningAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningAssignment" ADD CONSTRAINT "LearningAssignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningAssignment" ADD CONSTRAINT "LearningAssignment_mandatoryTrainingId_fkey" FOREIGN KEY ("mandatoryTrainingId") REFERENCES "MandatoryTraining"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningAssignment" ADD CONSTRAINT "LearningAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningAssignment" ADD CONSTRAINT "LearningAssignment_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
