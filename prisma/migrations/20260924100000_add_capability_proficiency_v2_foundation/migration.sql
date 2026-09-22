-- Phase 30.1 — Capability & Proficiency V2 foundation (schema only).
-- docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md,
-- docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_PREFLIGHT.md.
--
-- Purely additive: new columns are nullable or carry a migration-safe
-- default (state DEFAULT 'ACTIVE', revision/eventSeq DEFAULT 0), so this is
-- a metadata-only change on Postgres 11+ for every existing row — no
-- backfill, no rewrite. SkillProficiencyEvent is a brand-new, empty table.
-- No existing writer changes; V1's calculation
-- (src/lib/domain/capability/proficiency.ts) remains authoritative.

-- CreateEnum
CREATE TYPE "EvidenceState" AS ENUM ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EvidenceConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ProficiencyEventCause" AS ENUM ('BASELINE', 'EVIDENCE_ADDED', 'EVIDENCE_VERIFIED', 'VERIFICATION_REVOKED', 'EVIDENCE_REJECTED', 'EVIDENCE_REOPENED', 'EVIDENCE_EXPIRED', 'EVIDENCE_SUPERSEDED', 'EVIDENCE_REVOKED', 'EVIDENCE_REINSTATED', 'RECALCULATED');

-- AlterTable
ALTER TABLE "SkillEvidence" ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scorePercent" DOUBLE PRECISION,
ADD COLUMN     "state" "EvidenceState" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "validUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UserSkill" ADD COLUMN     "eventSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "evidenceConfidence" "EvidenceConfidence",
ADD COLUMN     "policyVersion" INTEGER;

-- CreateTable
CREATE TABLE "SkillProficiencyEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "cause" "ProficiencyEventCause" NOT NULL,
    "evidenceId" TEXT,
    "evidenceRevision" INTEGER,
    "actorId" TEXT,
    "actorRole" "Role",
    "reason" TEXT,
    "previousProficiency" "SkillProficiency",
    "newProficiency" "SkillProficiency" NOT NULL,
    "previousConfidence" "EvidenceConfidence",
    "newConfidence" "EvidenceConfidence",
    "policyVersion" INTEGER NOT NULL,
    "contributing" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillProficiencyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillProficiencyEvent_tenantId_skillId_recordedAt_idx" ON "SkillProficiencyEvent"("tenantId", "skillId", "recordedAt");

-- CreateIndex
CREATE INDEX "SkillProficiencyEvent_tenantId_userId_skillId_recordedAt_idx" ON "SkillProficiencyEvent"("tenantId", "userId", "skillId", "recordedAt");

-- CreateIndex
CREATE INDEX "SkillProficiencyEvent_tenantId_cause_recordedAt_idx" ON "SkillProficiencyEvent"("tenantId", "cause", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SkillProficiencyEvent_userId_skillId_seq_key" ON "SkillProficiencyEvent"("userId", "skillId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SkillProficiencyEvent_evidenceId_evidenceRevision_key" ON "SkillProficiencyEvent"("evidenceId", "evidenceRevision");

-- CreateIndex
--
-- Phase 30 pre-flight audit §5/§24: Skill is a small, tenant-scoped catalog
-- table (bounded by how many skills a tenant defines — not a high-volume
-- event/log table like SkillEvidence), so a plain (non-CONCURRENTLY) unique
-- index build is low-risk here; this is the documented exception the audit's
-- §5 migration-safety rule explicitly allows ("or document why a particular
-- index does not need concurrent creation"). This index is also the
-- required uniqueness target for the composite FK added below.
CREATE UNIQUE INDEX "Skill_id_tenantId_key" ON "Skill"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "SkillProficiencyEvent" ADD CONSTRAINT "SkillProficiencyEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillProficiencyEvent" ADD CONSTRAINT "SkillProficiencyEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillProficiencyEvent" ADD CONSTRAINT "SkillProficiencyEvent_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillProficiencyEvent" ADD CONSTRAINT "SkillProficiencyEvent_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "SkillEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillProficiencyEvent" ADD CONSTRAINT "SkillProficiencyEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (composite tenant-consistency constraint, defense in depth)
--
-- Phase 30 pre-flight audit §5/§19/§24: this is the ONE tenant relationship
-- the audit found clean in the data it could check and safe to constrain
-- now. The other three proposed relationships (SkillEvidence vs User,
-- SkillEvidence vs Skill, UserSkill vs User) are deliberately NOT added
-- here — they are gated on a production-data re-run of the audit's §5
-- queries and are out of scope for 30.1 (see the audit's approval-gate
-- condition 1). Do not add them without re-running that audit first.
--
-- Added NOT VALID (a fast, metadata-only change — no table scan, brief
-- ACCESS EXCLUSIVE lock only) and validated separately in the next
-- statement (a full table scan, but under SHARE UPDATE EXCLUSIVE, which
-- does not block concurrent reads or writes) — the two-step technique the
-- audit's §19/§24 named as missing from the original zero-downtime claim.
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_skillId_tenantId_fkey"
  FOREIGN KEY ("skillId", "tenantId") REFERENCES "Skill"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "UserSkill" VALIDATE CONSTRAINT "UserSkill_skillId_tenantId_fkey";
