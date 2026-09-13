import { auth } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { AI_SEARCH_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { buildAIContext, type KnowledgeContextItem } from "@/lib/ai/runtime/context";
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
import { searchRatelimit } from "@/lib/ratelimit";

const MAX_QUERY_LENGTH = 2000;
const TOP_K = 5;

// .strict() rejects any unexpected field outright (tenantId/userId/courseId/
// lessonId/etc.) rather than silently ignoring it — the caller never gets to
// influence scope beyond the natural-language query itself.
const searchRequestSchema = z
  .object({ query: z.string().trim().min(1).max(MAX_QUERY_LENGTH) })
  .strict();

export type AISearchCitation = {
  documentId: string;
  documentTitle: string;
  sourceId: string;
  excerpt: string;
  score: number;
};

/**
 * Client-facing citations are built exclusively from the server's own
 * retrieval results (searchKnowledge, via buildAIContext) — never parsed
 * from the model's answer text. A hallucinated or out-of-range reference in
 * the generated prose can therefore never become a fake client citation:
 * nothing here reads the model's output to construct this array.
 *
 * Retrieval is already rank-ordered (searchKnowledge's ORDER BY), so keeping
 * the first occurrence per documentId keeps the highest-ranked chunk.
 */
export function dedupeCitationsByDocument(knowledge: KnowledgeContextItem[]): AISearchCitation[] {
  const seen = new Set<string>();
  const citations: AISearchCitation[] = [];
  for (const item of knowledge) {
    if (seen.has(item.documentId)) continue;
    seen.add(item.documentId);
    citations.push({
      documentId: item.documentId,
      documentTitle: item.citation.documentTitle,
      sourceId: item.sourceId,
      excerpt: item.content,
      score: item.score,
    });
  }
  return citations;
}

export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, searchRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  // Search has no legacy/solo fallback the way Tutor does for FREE-plan
  // users — its entire purpose is the tenant Knowledge base, so a user with
  // no tenant is rejected outright rather than silently degraded.
  if (!user.tenantId) {
    return Response.json({ error: "No organisation found" }, { status: 400 });
  }

  // Phase 10 locked scope: STUDENT only. ORG_ADMIN/INSTRUCTOR do not get
  // Search access this phase (see docs/V2_ROADMAP.md, Phase 10).
  if (user.role !== "STUDENT") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = searchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid query" }, { status: 400 });
  }
  const { query } = parsed.data;

  const aiRequestContext: AIRequestContext = {
    auth: { userId: user.id, clerkId: userId as string, tenantId: user.tenantId, role: user.role },
    surface: "SEARCH",
  };
  // Always passes today (SEARCH.GENERATE is true per the locked Phase 10
  // policy change) — the route still asserts it explicitly rather than
  // assuming, matching every other AI route's convention.
  assertActionAllowed(aiRequestContext.surface, "GENERATE");

  // Knowledge-only grounding — no lessonId/courseId, no enrollment gate.
  // buildAIContext re-authorizes retrieval itself via searchKnowledge; the
  // route never queries Knowledge directly.
  const aiContext = await buildAIContext(aiRequestContext, { query, topK: TOP_K });
  const knowledge = aiContext.knowledge;

  const { model, provider, modelId } = modelFor(aiRequestContext.surface);

  let conversationId: string | undefined;
  let executionId: string | undefined;
  const startedAt = Date.now();
  try {
    const conversation = await createConversation(
      { tenantId: user.tenantId, userId: user.id },
      { surface: aiRequestContext.surface, contextMetadata: { query } }
    );
    conversationId = conversation.id;
    const execution = await startExecution(
      { tenantId: user.tenantId, userId: user.id },
      { model: modelId, provider, operation: "search.query", conversationId }
    );
    executionId = execution.id;
    await persistMessage(conversationId, "user", query);
  } catch (err) {
    // Persistence setup failing must not block the search response — see
    // docs/V2_AI_ARCHITECTURE.md, "Error handling".
    console.error("[ai-runtime] Failed to start V2 conversation/execution", err);
    conversationId = undefined;
    executionId = undefined;
  }

  const executionTracker = createExecutionTracker(executionId, startedAt);

  let answer: string;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  try {
    const knowledgeBlocks = knowledge.map((k) =>
      `${k.citation.documentTitle}\n${k.content}`.trim()
    );
    const result = await generateText({
      model,
      system: AI_SEARCH_SYSTEM_PROMPT(knowledgeBlocks),
      prompt: query,
    });
    answer = result.text.trim();
    inputTokens = result.usage?.inputTokens;
    outputTokens = result.usage?.outputTokens;
  } catch (err) {
    console.error("[ai-runtime] search generation failed", err);
    await executionTracker.markFailed(err);
    return Response.json(
      { error: "AI failed to generate a search answer. Please try again." },
      { status: 502 }
    );
  }

  // Unconditional, exactly like the tutor route — the model call already
  // succeeded by this point; quota accounting doesn't depend on V2 bookkeeping.
  await incrementAiUsage(user.id);
  await executionTracker.markSucceeded({ inputTokens, outputTokens });

  // V2 persistence: additive, best-effort — never fails a response that has
  // already succeeded (docs/V2_AI_ARCHITECTURE.md, "Error handling").
  if (conversationId && executionId) {
    try {
      const assistantMessage = await persistMessage(conversationId, "assistant", answer);
      if (knowledge.length > 0) {
        await persistCitations(conversationId, assistantMessage.id, knowledge);
      }
      await recordUsageEvent(
        { tenantId: user.tenantId, userId: user.id },
        {
          executionId,
          operation: "search.query",
          provider,
          model: modelId,
          inputTokens,
          outputTokens,
        }
      );
    } catch (err) {
      console.error("[ai-runtime] Failed to persist V2 search conversation/usage", err);
    }
  }

  const citations = dedupeCitationsByDocument(knowledge);
  return Response.json({ answer, citations });
}
