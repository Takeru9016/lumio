import { generateObject } from "ai";
import { COURSE_CREATOR_CURRICULUM_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { createExecutionTracker } from "@/lib/ai/runtime/execution";
import {
  createConversation,
  persistCitations,
  persistMessage,
  recordUsageEvent,
  startExecution,
} from "@/lib/ai/runtime/persistence";
import { assertActionAllowed } from "@/lib/ai/runtime/policy";
import { modelFor } from "@/lib/ai/runtime/provider";
import type { AIRequestContext } from "@/lib/ai/runtime/types";
import { db } from "@/lib/db";
import { buildCourseProposalSchema } from "@/lib/domain/course-creator/schema";
import type {
  CourseCreatorInput,
  CourseCreatorKnowledgeItem,
  CourseProposalResult,
} from "@/lib/domain/course-creator/types";
import type { KnowledgeAccessContext } from "@/lib/domain/knowledge/access";
import { searchKnowledge } from "@/lib/domain/knowledge/retrieval";

const KNOWLEDGE_TOP_K_PER_DOCUMENT = 4;
const KNOWLEDGE_TOP_K_TENANT_WIDE = 8;
const MAX_KNOWLEDGE_ITEMS = 12;
const MAX_CONTENT_CHARS_PER_ITEM = 1200;

/**
 * Retrieves authorized Knowledge for the curriculum prompt. When the creator
 * selected specific documents, retrieval is scoped per-document (still
 * through searchKnowledge, so authorization is enforced identically); with no
 * selection, falls back to one tenant-wide semantic search on the goal text.
 * Every result is deduplicated by chunkId and capped at MAX_KNOWLEDGE_ITEMS —
 * this list, not the raw chunk store, is what the model ever sees.
 */
async function retrieveKnowledge(
  ctx: KnowledgeAccessContext,
  query: string,
  documentIds: string[] | undefined
): Promise<CourseCreatorKnowledgeItem[]> {
  const seen = new Map<string, CourseCreatorKnowledgeItem>();

  if (documentIds && documentIds.length > 0) {
    for (const documentId of documentIds) {
      const results = await searchKnowledge(ctx, query, {
        documentId,
        topK: KNOWLEDGE_TOP_K_PER_DOCUMENT,
      });
      for (const r of results) if (!seen.has(r.chunkId)) seen.set(r.chunkId, r);
    }
  } else {
    const results = await searchKnowledge(ctx, query, { topK: KNOWLEDGE_TOP_K_TENANT_WIDE });
    for (const r of results) if (!seen.has(r.chunkId)) seen.set(r.chunkId, r);
  }

  return [...seen.values()].slice(0, MAX_KNOWLEDGE_ITEMS);
}

/**
 * Generates a validated CourseProposal (AISurface.COURSE_CREATOR / GENERATE).
 * Pure generation — no Course/Section/Lesson row is created here or anywhere
 * in this module; see saveDraft.ts for the human/application write boundary.
 */
export async function generateCourseProposal(
  reqCtx: AIRequestContext,
  input: CourseCreatorInput
): Promise<CourseProposalResult> {
  assertActionAllowed(reqCtx.surface, "READ");
  assertActionAllowed(reqCtx.surface, "GENERATE");

  const tenantId = reqCtx.auth.tenantId;
  if (!tenantId) {
    throw new Error("generateCourseProposal requires an authenticated tenant");
  }
  const knowledgeCtx: KnowledgeAccessContext = { ...reqCtx.auth, tenantId };

  const [knowledge, skills] = await Promise.all([
    retrieveKnowledge(knowledgeCtx, input.goal, input.knowledgeDocumentIds),
    input.targetSkillIds && input.targetSkillIds.length > 0
      ? db.skill.findMany({
          where: { id: { in: input.targetSkillIds }, tenantId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const conversation = await createConversation(
    { tenantId, userId: reqCtx.auth.userId },
    {
      surface: reqCtx.surface,
      title: input.goal.slice(0, 120),
      contextMetadata: { stage: "curriculum" },
    }
  );
  const { model, provider, modelId } = modelFor(reqCtx.surface);
  const execution = await startExecution(
    { tenantId, userId: reqCtx.auth.userId },
    {
      model: modelId,
      provider,
      operation: "course-creator.curriculum",
      conversationId: conversation.id,
    }
  );
  const tracker = createExecutionTracker(execution.id, Date.now());

  await persistMessage(conversation.id, "user", input.goal, {
    audience: input.audience,
    difficulty: input.difficulty,
    durationHours: input.durationHours,
  });

  const knowledgeExcerpts = knowledge.map((k) => k.content.slice(0, MAX_CONTENT_CHARS_PER_ITEM));

  try {
    const schema = buildCourseProposalSchema(knowledge.length);
    const { object, usage } = await generateObject({
      model,
      schema,
      system: COURSE_CREATOR_CURRICULUM_SYSTEM_PROMPT({
        goal: input.goal,
        audience: input.audience,
        difficulty: input.difficulty,
        durationHours: input.durationHours,
        assessmentStyle: input.assessmentStyle,
        skillNames: skills.map((s) => s.name),
        knowledge: knowledgeExcerpts,
      }),
      prompt: "Generate the curriculum proposal now.",
    });

    const usedIndices = new Set<number>();
    for (const section of object.sections) {
      for (const lesson of section.lessons) {
        for (const i of lesson.citationIndices) usedIndices.add(i);
      }
    }
    const usedKnowledge = [...usedIndices]
      .map((i) => knowledge[i])
      .filter((k): k is CourseCreatorKnowledgeItem => !!k);

    const assistantMessage = await persistMessage(
      conversation.id,
      "assistant",
      JSON.stringify(object).slice(0, 20000)
    );
    if (usedKnowledge.length > 0) {
      await persistCitations(conversation.id, assistantMessage.id, usedKnowledge);
    }

    await tracker.markSucceeded({
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
    await recordUsageEvent(
      { tenantId, userId: reqCtx.auth.userId },
      {
        executionId: execution.id,
        operation: "course-creator.curriculum",
        provider,
        model: modelId,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }
    );

    return {
      proposal: object,
      knowledge,
      conversationId: conversation.id,
      executionId: execution.id,
    };
  } catch (err) {
    await tracker.markFailed(err);
    throw err;
  }
}
