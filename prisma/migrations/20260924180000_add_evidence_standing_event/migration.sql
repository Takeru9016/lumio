-- Phase 30.3 — evidence-standing audit table (schema addition only).
-- docs/PHASE_30.3_DISCOVERY.md §26, docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md §Q.
--
-- Purely additive: one new enum, one new (empty) table with five foreign
-- keys, no change to any existing column. No existing writer changes as a
-- result of this migration alone.
--
-- KNOWN, EXPECTED DIFF NOISE (do not "fix" this by adding it back): running
-- `prisma migrate diff` against the live database emits a spurious
-- `DROP CONSTRAINT "UserSkill_skillId_tenantId_fkey"` line, because that
-- composite tenant FK (30.1, contract §H8) was added as raw SQL, not a
-- Prisma-modeled relation, and `prisma migrate diff` cannot see it in
-- schema.prisma. That line has been removed from this migration file by
-- hand. See prisma/migrations/20260924100000_add_capability_proficiency_v2_foundation/migration.sql's
-- own header for the original note. Whoever next runs `prisma migrate dev`
-- against this schema should not accept an auto-suggested drop of that
-- constraint either.

-- CreateEnum
CREATE TYPE "EvidenceStandingAction" AS ENUM ('VERIFY', 'REJECT', 'UNVERIFY', 'REOPEN', 'REVOKE', 'REINSTATE', 'EXPIRE', 'SUPERSEDE');

-- CreateTable
CREATE TABLE "EvidenceStandingEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "evidenceRevision" INTEGER NOT NULL,
    "action" "EvidenceStandingAction" NOT NULL,
    "actorId" TEXT,
    "actorRole" "Role",
    "actorName" TEXT,
    "reason" TEXT,
    "previousVerificationStatus" "EvidenceVerificationStatus" NOT NULL,
    "newVerificationStatus" "EvidenceVerificationStatus" NOT NULL,
    "previousState" "EvidenceState" NOT NULL,
    "newState" "EvidenceState" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceStandingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceStandingEvent_tenantId_evidenceId_recordedAt_idx" ON "EvidenceStandingEvent"("tenantId", "evidenceId", "recordedAt");

-- CreateIndex
CREATE INDEX "EvidenceStandingEvent_tenantId_userId_recordedAt_idx" ON "EvidenceStandingEvent"("tenantId", "userId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceStandingEvent_evidenceId_evidenceRevision_key" ON "EvidenceStandingEvent"("evidenceId", "evidenceRevision");

-- AddForeignKey
ALTER TABLE "EvidenceStandingEvent" ADD CONSTRAINT "EvidenceStandingEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceStandingEvent" ADD CONSTRAINT "EvidenceStandingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceStandingEvent" ADD CONSTRAINT "EvidenceStandingEvent_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceStandingEvent" ADD CONSTRAINT "EvidenceStandingEvent_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "SkillEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceStandingEvent" ADD CONSTRAINT "EvidenceStandingEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
