-- CreateIndex
CREATE UNIQUE INDEX "SkillEvidence_tenantId_userId_skillId_sourceType_sourceId_key" ON "SkillEvidence"("tenantId", "userId", "skillId", "sourceType", "sourceId");
