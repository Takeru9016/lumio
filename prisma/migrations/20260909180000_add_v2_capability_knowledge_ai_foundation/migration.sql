-- CreateEnum
CREATE TYPE "SkillProficiency" AS ENUM ('NONE', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT');

-- CreateEnum
CREATE TYPE "SkillStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('COURSE_COMPLETION', 'QUIZ_SCORE', 'ASSIGNMENT', 'ASSESSMENT', 'PROJECT', 'MANAGER_ASSESSMENT', 'CERTIFICATION', 'AI_EVALUATION', 'MANUAL');

-- CreateEnum
CREATE TYPE "EvidenceVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM ('COURSE', 'LESSON', 'DOCUMENT', 'POLICY', 'TRANSCRIPT', 'EXTERNAL', 'WEBPAGE', 'MANUAL');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "AIConversationType" AS ENUM ('TUTOR', 'COURSE_BUILDER', 'ANALYTICS', 'COACH', 'GENERAL');

-- CreateEnum
CREATE TYPE "AIExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LearningEventType" AS ENUM ('COURSE_ENROLLED', 'COURSE_COMPLETED', 'LESSON_STARTED', 'LESSON_COMPLETED', 'QUIZ_STARTED', 'QUIZ_COMPLETED', 'ASSIGNMENT_SUBMITTED', 'ASSIGNMENT_GRADED', 'SKILL_ASSESSED', 'SKILL_EVIDENCE_CREATED', 'CERTIFICATE_ISSUED', 'AI_TUTOR_USED', 'RECOMMENDATION_ACCEPTED', 'LEARNING_PATH_COMPLETED');

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "knowledgeDocumentId" TEXT;

-- CreateTable
CREATE TABLE "SkillCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "SkillStatus" NOT NULL DEFAULT 'ACTIVE',
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleSkill" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "requiredProficiency" "SkillProficiency" NOT NULL DEFAULT 'BEGINNER',
    "isRequired" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RoleSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserJobRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserJobRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSkill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "proficiency" "SkillProficiency" NOT NULL DEFAULT 'NONE',
    "targetProficiency" "SkillProficiency",
    "confidence" INTEGER,
    "status" "SkillStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastAssessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillEvidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "userSkillId" TEXT,
    "type" "EvidenceType" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "proficiency" "SkillProficiency",
    "score" DOUBLE PRECISION,
    "metadata" JSONB,
    "verificationStatus" "EvidenceVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseSkill" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "KnowledgeSourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "externalId" TEXT,
    "metadata" JSONB,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mimeType" TEXT,
    "url" TEXT,
    "textContent" TEXT,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "tokenCount" INTEGER,
    "metadata" JSONB,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "type" "AIConversationType" NOT NULL DEFAULT 'GENERAL',
    "contextMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIToolCall" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "toolName" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "status" "AIExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AIToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AISourceCitation" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "knowledgeChunkId" TEXT,
    "metadata" JSONB,
    "relevance" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AISourceCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIExecution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "AIExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" DOUBLE PRECISION,
    "error" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AIExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "executionId" TEXT,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" "LearningEventType" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillCategory_tenantId_idx" ON "SkillCategory"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillCategory_tenantId_slug_key" ON "SkillCategory"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "Skill_tenantId_idx" ON "Skill"("tenantId");

-- CreateIndex
CREATE INDEX "Skill_categoryId_idx" ON "Skill"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_tenantId_slug_key" ON "Skill"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "JobRole_tenantId_idx" ON "JobRole"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRole_tenantId_slug_key" ON "JobRole"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "RoleSkill_skillId_idx" ON "RoleSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleSkill_roleId_skillId_key" ON "RoleSkill"("roleId", "skillId");

-- CreateIndex
CREATE INDEX "UserJobRole_tenantId_idx" ON "UserJobRole"("tenantId");

-- CreateIndex
CREATE INDEX "UserJobRole_roleId_idx" ON "UserJobRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserJobRole_userId_roleId_key" ON "UserJobRole"("userId", "roleId");

-- CreateIndex
CREATE INDEX "UserSkill_tenantId_idx" ON "UserSkill"("tenantId");

-- CreateIndex
CREATE INDEX "UserSkill_skillId_idx" ON "UserSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSkill_userId_skillId_key" ON "UserSkill"("userId", "skillId");

-- CreateIndex
CREATE INDEX "SkillEvidence_tenantId_idx" ON "SkillEvidence"("tenantId");

-- CreateIndex
CREATE INDEX "SkillEvidence_userId_idx" ON "SkillEvidence"("userId");

-- CreateIndex
CREATE INDEX "SkillEvidence_skillId_idx" ON "SkillEvidence"("skillId");

-- CreateIndex
CREATE INDEX "SkillEvidence_sourceType_sourceId_idx" ON "SkillEvidence"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CourseSkill_skillId_idx" ON "CourseSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseSkill_courseId_skillId_key" ON "CourseSkill"("courseId", "skillId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_tenantId_idx" ON "KnowledgeSource"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_tenantId_type_idx" ON "KnowledgeSource"("tenantId", "type");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenantId_idx" ON "KnowledgeDocument"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_sourceId_idx" ON "KnowledgeDocument"("sourceId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenantId_status_idx" ON "KnowledgeDocument"("tenantId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenantId_idx" ON "KnowledgeChunk"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_documentId_chunkIndex_key" ON "KnowledgeChunk"("documentId", "chunkIndex");

-- CreateIndex
CREATE INDEX "AIConversation_tenantId_idx" ON "AIConversation"("tenantId");

-- CreateIndex
CREATE INDEX "AIConversation_userId_idx" ON "AIConversation"("userId");

-- CreateIndex
CREATE INDEX "AIMessage_conversationId_idx" ON "AIMessage"("conversationId");

-- CreateIndex
CREATE INDEX "AIToolCall_conversationId_idx" ON "AIToolCall"("conversationId");

-- CreateIndex
CREATE INDEX "AIToolCall_messageId_idx" ON "AIToolCall"("messageId");

-- CreateIndex
CREATE INDEX "AISourceCitation_conversationId_idx" ON "AISourceCitation"("conversationId");

-- CreateIndex
CREATE INDEX "AISourceCitation_messageId_idx" ON "AISourceCitation"("messageId");

-- CreateIndex
CREATE INDEX "AISourceCitation_knowledgeChunkId_idx" ON "AISourceCitation"("knowledgeChunkId");

-- CreateIndex
CREATE INDEX "AIExecution_tenantId_idx" ON "AIExecution"("tenantId");

-- CreateIndex
CREATE INDEX "AIExecution_userId_idx" ON "AIExecution"("userId");

-- CreateIndex
CREATE INDEX "AIExecution_conversationId_idx" ON "AIExecution"("conversationId");

-- CreateIndex
CREATE INDEX "AIExecution_tenantId_createdAt_idx" ON "AIExecution"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AIUsageEvent_tenantId_idx" ON "AIUsageEvent"("tenantId");

-- CreateIndex
CREATE INDEX "AIUsageEvent_userId_idx" ON "AIUsageEvent"("userId");

-- CreateIndex
CREATE INDEX "AIUsageEvent_tenantId_createdAt_idx" ON "AIUsageEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "LearningEvent_tenantId_occurredAt_idx" ON "LearningEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "LearningEvent_userId_occurredAt_idx" ON "LearningEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "LearningEvent_eventType_occurredAt_idx" ON "LearningEvent"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "LearningEvent_entityType_entityId_idx" ON "LearningEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Lesson_knowledgeDocumentId_idx" ON "Lesson"("knowledgeDocumentId");

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_knowledgeDocumentId_fkey" FOREIGN KEY ("knowledgeDocumentId") REFERENCES "KnowledgeDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillCategory" ADD CONSTRAINT "SkillCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SkillCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRole" ADD CONSTRAINT "JobRole_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleSkill" ADD CONSTRAINT "RoleSkill_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "JobRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleSkill" ADD CONSTRAINT "RoleSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserJobRole" ADD CONSTRAINT "UserJobRole_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserJobRole" ADD CONSTRAINT "UserJobRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserJobRole" ADD CONSTRAINT "UserJobRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "JobRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillEvidence" ADD CONSTRAINT "SkillEvidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillEvidence" ADD CONSTRAINT "SkillEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillEvidence" ADD CONSTRAINT "SkillEvidence_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillEvidence" ADD CONSTRAINT "SkillEvidence_userSkillId_fkey" FOREIGN KEY ("userSkillId") REFERENCES "UserSkill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillEvidence" ADD CONSTRAINT "SkillEvidence_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseSkill" ADD CONSTRAINT "CourseSkill_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseSkill" ADD CONSTRAINT "CourseSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIMessage" ADD CONSTRAINT "AIMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIToolCall" ADD CONSTRAINT "AIToolCall_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIToolCall" ADD CONSTRAINT "AIToolCall_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AIMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AISourceCitation" ADD CONSTRAINT "AISourceCitation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AISourceCitation" ADD CONSTRAINT "AISourceCitation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AIMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AISourceCitation" ADD CONSTRAINT "AISourceCitation_knowledgeChunkId_fkey" FOREIGN KEY ("knowledgeChunkId") REFERENCES "KnowledgeChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIExecution" ADD CONSTRAINT "AIExecution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIExecution" ADD CONSTRAINT "AIExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIExecution" ADD CONSTRAINT "AIExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsageEvent" ADD CONSTRAINT "AIUsageEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsageEvent" ADD CONSTRAINT "AIUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsageEvent" ADD CONSTRAINT "AIUsageEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "AIExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
