import { generateObject } from "ai";
import { COURSE_CREATOR_CONTENT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
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
import { buildLessonContentProposalSchema } from "@/lib/domain/course-creator/schema";
import type {
  CourseCreatorKnowledgeItem,
  LessonContentProposal,
} from "@/lib/domain/course-creator/types";
import type { KnowledgeAccessContext } from "@/lib/domain/knowledge/access";
import { searchKnowledge } from "@/lib/domain/knowledge/retrieval";

const KNOWLEDGE_TOP_K = 5;
const MAX_CONTENT_CHARS_PER_ITEM = 1200;

const ALLOWED_TAGS = new Set(["h2", "h3", "p", "ul", "ol", "li", "pre", "code"]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serializes structured content blocks (see schema.ts's contentBlockSchema)
 * into HTML using only the fixed ALLOWED_TAGS set, with every text value
 * escaped. The model never produces HTML directly — this is the only place
 * lesson-editor markup is generated, so it's the only place that needs to be
 * an allowlisted renderer rather than a sanitizer over free-form model output.
 */
type ContentBlock = LessonContentProposal["blocks"][number];

export function serializeBlocksToHtml(blocks: ContentBlock[]): string {
  return blocks
    .map((block: ContentBlock) => {
      switch (block.type) {
        case "heading": {
          const tag = `h${block.level}` as "h2" | "h3";
          if (!ALLOWED_TAGS.has(tag)) return "";
          return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
        }
        case "paragraph":
          return `<p>${escapeHtml(block.text)}</p>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const items = block.items.map((item: string) => `<li>${escapeHtml(item)}</li>`).join("");
          return `<${tag}>${items}</${tag}>`;
        }
        case "code":
          return `<pre><code>${escapeHtml(block.code)}</code></pre>`;
        default:
          return "";
      }
    })
    .join("\n");
}

export type GenerateLessonContentParams = {
  courseGoal: string;
  lessonTitle: string;
  lessonObjective?: string;
  knowledgeDocumentIds?: string[];
};

export type LessonContentResult = {
  blocks: LessonContentProposal["blocks"];
  html: string;
  knowledge: CourseCreatorKnowledgeItem[];
  conversationId?: string;
  executionId?: string;
};

/** Generates a lesson-content proposal (AISurface.COURSE_CREATOR / GENERATE). Never writes Lesson.textContent itself. */
export async function generateLessonContent(
  reqCtx: AIRequestContext,
  params: GenerateLessonContentParams
): Promise<LessonContentResult> {
  assertActionAllowed(reqCtx.surface, "READ");
  assertActionAllowed(reqCtx.surface, "GENERATE");

  const tenantId = reqCtx.auth.tenantId;
  if (!tenantId) {
    throw new Error("generateLessonContent requires an authenticated tenant");
  }
  const knowledgeCtx: KnowledgeAccessContext = { ...reqCtx.auth, tenantId };

  const seen = new Map<string, CourseCreatorKnowledgeItem>();
  const query = `${params.lessonTitle} ${params.lessonObjective ?? ""}`.trim();
  const documentIds = params.knowledgeDocumentIds;
  if (documentIds && documentIds.length > 0) {
    for (const documentId of documentIds) {
      const results = await searchKnowledge(knowledgeCtx, query, {
        documentId,
        topK: KNOWLEDGE_TOP_K,
      });
      for (const r of results) if (!seen.has(r.chunkId)) seen.set(r.chunkId, r);
    }
  } else {
    const results = await searchKnowledge(knowledgeCtx, query, { topK: KNOWLEDGE_TOP_K });
    for (const r of results) if (!seen.has(r.chunkId)) seen.set(r.chunkId, r);
  }
  const knowledge = [...seen.values()];

  const conversation = await createConversation(
    { tenantId, userId: reqCtx.auth.userId },
    {
      surface: reqCtx.surface,
      title: params.lessonTitle.slice(0, 120),
      contextMetadata: { stage: "content" },
    }
  );
  const { model, provider, modelId } = modelFor(reqCtx.surface);
  const execution = await startExecution(
    { tenantId, userId: reqCtx.auth.userId },
    {
      model: modelId,
      provider,
      operation: "course-creator.content",
      conversationId: conversation.id,
    }
  );
  const tracker = createExecutionTracker(execution.id, Date.now());

  await persistMessage(conversation.id, "user", query);

  try {
    const schema = buildLessonContentProposalSchema(knowledge.length);
    const { object, usage } = await generateObject({
      model,
      schema,
      system: COURSE_CREATOR_CONTENT_SYSTEM_PROMPT({
        courseGoal: params.courseGoal,
        lessonTitle: params.lessonTitle,
        lessonObjective: params.lessonObjective,
        knowledge: knowledge.map((k) => k.content.slice(0, MAX_CONTENT_CHARS_PER_ITEM)),
      }),
      prompt: "Generate the lesson content now.",
    });

    const usedKnowledge = object.citationIndices
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
        operation: "course-creator.content",
        provider,
        model: modelId,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }
    );

    return {
      blocks: object.blocks,
      html: serializeBlocksToHtml(object.blocks),
      knowledge: usedKnowledge,
      conversationId: conversation.id,
      executionId: execution.id,
    };
  } catch (err) {
    await tracker.markFailed(err);
    throw err;
  }
}
