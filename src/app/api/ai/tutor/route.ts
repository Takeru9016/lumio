import { auth } from "@clerk/nextjs/server";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import type { Prisma } from "@/generated/prisma/client";
import { withAiGuards } from "@/lib/ai/middleware";
import { TUTOR_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { buildAIContext } from "@/lib/ai/runtime/context";
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
import { searchSimilarLessons } from "@/lib/ai/search";
import { db } from "@/lib/db";
import { tutorRatelimit } from "@/lib/ratelimit";

// Only the most recent turns are sent to the model; full history is persisted.
const MODEL_CONTEXT_WINDOW = 10;
const RAG_TOP_K = 3;

interface TutorRequestBody {
  messages: UIMessage[];
  lessonId?: string;
  courseId?: string;
  chatId?: string;
}

/**
 * Extracts the plain text of the most recent user message from its UIMessage
 * parts (v5+ messages carry text in `parts`, not `.content`).
 */
function lastUserMessageText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Persists the full UIMessage[] to the user's AIChat for this lesson (or the
 * standalone chat when lessonId is absent). Ownership-scoped: a client-supplied
 * chatId can only update a row the user owns, otherwise a fresh chat is created.
 */
async function persistChat(
  dbUserId: string,
  lessonId: string | undefined,
  chatId: string | undefined,
  messages: UIMessage[]
): Promise<void> {
  const data = messages as unknown as Prisma.InputJsonValue;

  if (chatId) {
    const { count } = await db.aIChat.updateMany({
      where: { id: chatId, userId: dbUserId },
      data: { messages: data },
    });
    if (count > 0) return;
  }

  const existing = await db.aIChat.findFirst({
    where: { userId: dbUserId, lessonId: lessonId ?? null },
    select: { id: true },
  });

  if (existing) {
    await db.aIChat.update({
      where: { id: existing.id },
      data: { messages: data },
    });
    return;
  }

  await db.aIChat.create({
    data: { userId: dbUserId, lessonId: lessonId ?? null, messages: data },
  });
}

export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, tutorRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  let body: TutorRequestBody;
  try {
    body = (await req.json()) as TutorRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, lessonId, courseId, chatId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }

  // Enrollment guard: a lesson-scoped chat may only pull RAG context from a
  // course the user is actually enrolled in. Standalone chats (no lessonId) skip
  // this entirely.
  if (lessonId) {
    const enrollment = await db.enrollment.findFirst({
      where: {
        userId: user.id,
        course: {
          sections: { some: { lessons: { some: { id: lessonId } } } },
        },
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
    });
    if (!enrollment) {
      return new Response("Not enrolled in this course", { status: 403 });
    }
  }

  // Every AI call goes through the runtime's policy gate first — for TUTOR
  // this always currently passes (see src/lib/ai/runtime/policy.ts), but the
  // route no longer decides this itself.
  const aiRequestContext: AIRequestContext = {
    auth: { userId: user.id, clerkId: userId as string, tenantId: user.tenantId, role: user.role },
    surface: "TUTOR",
    conversationId: chatId,
    courseId,
    lessonId,
  };
  assertActionAllowed(aiRequestContext.surface, "GENERATE");

  // RAG: only for lesson-scoped chats. The standalone tutor skips retrieval and
  // sends no context block rather than an empty one.
  let context: string | undefined;
  let query = "";
  const knowledgeItems: Awaited<ReturnType<typeof buildAIContext>>["knowledge"] = [];
  if (lessonId) {
    query = lastUserMessageText(messages);
    if (query) {
      const contextBlocks: string[] = [];

      // Legacy lesson-scoped retrieval — unchanged from before this phase.
      const similar = await searchSimilarLessons(query, courseId, RAG_TOP_K);
      if (similar.length > 0) {
        contextBlocks.push(...similar.map((l) => `## ${l.title}\n${l.textContent ?? ""}`.trim()));
      }

      // V2 Knowledge-layer retrieval, now routed through the runtime's
      // context builder instead of calling searchKnowledge directly (see
      // src/lib/ai/runtime/context.ts). Only runs for tenant users — a
      // FREE-plan user.tenantId is null, so buildAIContext skips retrieval
      // and those chats fall back to lesson-only context exactly as before.
      // A retrieval failure is logged inside buildAIContext and degrades to
      // an empty knowledge array — it never breaks this request.
      const aiContext = await buildAIContext(aiRequestContext, { query, topK: RAG_TOP_K });
      knowledgeItems.push(...aiContext.knowledge);
      if (aiContext.knowledge.length > 0) {
        contextBlocks.push(
          ...aiContext.knowledge.map((r) => `## ${r.citation.documentTitle}\n${r.content}`.trim())
        );
      }

      if (contextBlocks.length > 0) {
        context = contextBlocks.join("\n\n");
      }
    }
  }

  // V2 persistence (AIConversation/AIExecution) only runs for tenant users —
  // same gate as Knowledge retrieval above, since every V2 AI table requires
  // a tenantId. FREE-plan users keep working exactly as before this phase:
  // legacy AIChat + aiCallsUsed only, no V2 rows at all.
  const { model, provider, modelId } = modelFor(aiRequestContext.surface);
  let conversationId: string | undefined;
  let executionId: string | undefined;
  const startedAt = Date.now();
  if (user.tenantId) {
    try {
      const conversation = await createConversation(
        { tenantId: user.tenantId, userId: user.id },
        { surface: aiRequestContext.surface, contextMetadata: { lessonId, courseId } }
      );
      conversationId = conversation.id;
      const execution = await startExecution(
        { tenantId: user.tenantId, userId: user.id },
        { model: modelId, provider, operation: "tutor.chat", conversationId }
      );
      executionId = execution.id;
      if (query) {
        await persistMessage(conversationId, "user", query);
      }
    } catch (err) {
      // Persistence setup failing must not block the tutor response — the
      // model call still proceeds; onEnd below re-checks conversationId/
      // executionId before doing anything V2-specific.
      console.error("[ai-runtime] Failed to start V2 conversation/execution", err);
      conversationId = undefined;
      executionId = undefined;
    }
  }

  // Ensures every AIExecution that was actually started reaches a terminal
  // state — streamText's onError, toUIMessageStream's onError, and the outer
  // catch below can all legitimately fire for the same underlying failure;
  // the tracker only lets the first one do anything (see execution.ts).
  const executionTracker = createExecutionTracker(executionId, startedAt);

  try {
    const result = streamText({
      model,
      system: TUTOR_SYSTEM_PROMPT(context),
      messages: await convertToModelMessages(messages.slice(-MODEL_CONTEXT_WINDOW)),
      onError: async ({ error }) => {
        // Fires on provider/model failures during generation. Logged with
        // full detail server-side; never sent to the client from here — the
        // client-facing message is produced by toUIMessageStream's onError below.
        console.error("[ai-runtime] streamText provider/model error", error);
        await executionTracker.markFailed(error);
      },
    });

    const stream = toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      onError: (error) => {
        // Fires on stream-level failures (including provider errors surfaced
        // through the stream). Must return synchronously, so the DB write is
        // fire-and-forget — the tracker catches its own persistence errors,
        // so this never produces an unhandled rejection. The returned string
        // is what the client sees: generic, never the raw provider error.
        console.error("[ai-runtime] tutor stream error", error);
        void executionTracker.markFailed(error);
        return "The tutor is temporarily unavailable. Please try again.";
      },
      onEnd: async ({ messages: finalMessages }) => {
        // After the stream succeeds: persist history, then count the AI call —
        // exactly as before this phase, unconditionally, regardless of V2 state.
        await persistChat(user.id, lessonId, chatId, finalMessages);
        await incrementAiUsage(user.id);

        // V2 persistence: additive, best-effort. Any failure here is logged,
        // never thrown — the user-facing tutor response has already succeeded
        // by this point and must not be retroactively failed by a bookkeeping
        // error (see docs/V2_AI_ARCHITECTURE.md, "Error handling").
        if (conversationId && executionId && user.tenantId && !executionTracker.finalized) {
          try {
            const lastMessage = finalMessages[finalMessages.length - 1];
            const assistantText =
              lastMessage?.role === "assistant"
                ? lastMessage.parts
                    .filter((p): p is { type: "text"; text: string } => p.type === "text")
                    .map((p) => p.text)
                    .join(" ")
                : "";

            const assistantMessage = await persistMessage(
              conversationId,
              "assistant",
              assistantText
            );
            if (knowledgeItems.length > 0) {
              await persistCitations(conversationId, assistantMessage.id, knowledgeItems);
            }

            let inputTokens: number | undefined;
            let outputTokens: number | undefined;
            try {
              const usage = await result.usage;
              inputTokens = usage?.inputTokens;
              outputTokens = usage?.outputTokens;
            } catch {
              // Usage isn't always available depending on stream finish reason —
              // token counts are best-effort observability, not required.
            }

            await executionTracker.markSucceeded({ inputTokens, outputTokens });
            await recordUsageEvent(
              { tenantId: user.tenantId, userId: user.id },
              {
                executionId,
                operation: "tutor.chat",
                provider,
                model: modelId,
                inputTokens,
                outputTokens,
              }
            );
          } catch (err) {
            console.error("[ai-runtime] Failed to persist V2 conversation/usage", err);
          }
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    // Covers failures before/while constructing the stream itself (e.g. a
    // synchronous setup error) — anything that would otherwise leave a
    // RUNNING execution with no onError/onEnd ever firing for it.
    await executionTracker.markFailed(err);
    throw err;
  }
}
