import { auth } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { AI_STAFF_COPILOT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { createExecutionTracker } from "@/lib/ai/runtime/execution";
import {
  createConversation,
  getConversationForContinuation,
  listRecentMessages,
  persistMessage,
  readConversationLearnerId,
  readConversationRoleId,
  recordUsageEvent,
  startExecution,
} from "@/lib/ai/runtime/persistence";
import { assertActionAllowed } from "@/lib/ai/runtime/policy";
import { modelFor } from "@/lib/ai/runtime/provider";
import {
  buildInstructorCopilotContext,
  InstructorCopilotLearnerNotFoundError,
} from "@/lib/domain/capability/instructorCopilotContext";
import { instructorCopilotRatelimit } from "@/lib/ratelimit";

const MAX_QUERY_LENGTH = 2000;
const SURFACE_MARKER = "INSTRUCTOR_COPILOT" as const;
// Model-input bound only (Phase 15 contract §8) — persisted history is never
// deleted or summarized; only what's sent to generateText is bounded.
const HISTORY_WINDOW = 10;

// .strict() rejects any unexpected field outright (tenantId/userId/instructorId/
// role/plan/etc.) — the only identity-like field the caller may ever supply is
// learnerId, and it is never used for a database lookup (see
// instructorCopilotContext.ts) — only to filter the already-authorized page.
const requestSchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    learnerId: z.string().min(1).optional(),
    roleId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
  })
  .strict();

/**
 * INSTRUCTOR-facing Capability Copilot (Phase 13 locked contract, extended
 * with Phase 15 conversation continuity) — explains the capability state of
 * students enrolled in courses this instructor owns. Deliberately NOT AI
 * Search: no buildAIContext, no searchKnowledge, no Knowledge retrieval, no
 * citations. Reuses the COPILOT surface and the existing instructor-ownership
 * boundary from Phase 11's getInstructorCapabilityReport() — never
 * re-derived here.
 */
export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, instructorCopilotRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  if (!user.tenantId) {
    return Response.json({ error: "No organisation found" }, { status: 400 });
  }

  // Phase 13 locked scope: INSTRUCTOR only. STUDENT/ORG_ADMIN/SUPER_ADMIN
  // all rejected — no shortcut for SUPER_ADMIN (see docs/V2_ROADMAP.md,
  // Phase 13).
  if (user.role !== "INSTRUCTOR") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid query" }, { status: 400 });
  }
  const { query, learnerId, roleId, conversationId: suppliedConversationId } = parsed.data;

  // Phase 21: a role only makes sense scoped to a specific learner — the
  // cohort-wide view has no single role to scope to.
  if (roleId && !learnerId) {
    return Response.json({ error: "roleId requires learnerId" }, { status: 400 });
  }

  const surface = "COPILOT" as const;
  assertActionAllowed(surface, "GENERATE");

  // Phase 15: resolve a supplied conversationId for continuation. Scoped to
  // {id, tenantId, userId} + the INSTRUCTOR_COPILOT surface marker in one
  // call. Any mismatch (not found, wrong tenant/user, wrong/missing surface)
  // becomes the same 404. A learner (and, Phase 21, role) scope, once set at
  // creation, is fixed for the conversation's lifetime — a continuation
  // attempting a different learnerId or roleId (including omitting one that
  // was originally set) is rejected with 400 rather than silently switching
  // or ignoring it.
  let existingConversation: Awaited<ReturnType<typeof getConversationForContinuation>> = null;
  if (suppliedConversationId) {
    existingConversation = await getConversationForContinuation(
      { tenantId: user.tenantId, userId: user.id },
      suppliedConversationId,
      SURFACE_MARKER
    );
    if (!existingConversation) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }
    const originalLearnerId = readConversationLearnerId(existingConversation.contextMetadata);
    if ((learnerId ?? null) !== originalLearnerId) {
      return Response.json(
        { error: "This conversation is scoped to a different learner" },
        { status: 400 }
      );
    }
    const originalRoleId = readConversationRoleId(existingConversation.contextMetadata);
    if ((roleId ?? null) !== originalRoleId) {
      return Response.json(
        { error: "This conversation is scoped to a different role" },
        { status: 400 }
      );
    }
  }

  // Capability context is always freshly assembled — never cached between
  // turns, whether this is a new conversation or a continuation.
  let capabilityContext: Awaited<ReturnType<typeof buildInstructorCopilotContext>>;
  try {
    capabilityContext = await buildInstructorCopilotContext(
      { userId: user.id, clerkId: userId as string, tenantId: user.tenantId, role: user.role },
      { learnerId, roleId }
    );
  } catch (err) {
    if (err instanceof InstructorCopilotLearnerNotFoundError) {
      return Response.json(
        { error: "Learner not found in your capability report" },
        { status: 404 }
      );
    }
    throw err;
  }

  const { model, provider, modelId } = modelFor(surface);

  let conversationId: string | undefined = existingConversation?.id;
  let executionId: string | undefined;
  const startedAt = Date.now();
  try {
    if (!conversationId) {
      const conversation = await createConversation(
        { tenantId: user.tenantId, userId: user.id },
        { surface, contextMetadata: { surface: SURFACE_MARKER, query, learnerId, roleId } }
      );
      conversationId = conversation.id;
    }
    const execution = await startExecution(
      { tenantId: user.tenantId, userId: user.id },
      { model: modelId, provider, operation: "capability.instructor.copilot", conversationId }
    );
    executionId = execution.id;
    await persistMessage(conversationId, "user", query);
  } catch (err) {
    console.error("[ai-runtime] Failed to start V2 conversation/execution", err);
    conversationId = existingConversation?.id;
    executionId = undefined;
  }

  const executionTracker = createExecutionTracker(executionId, startedAt);

  // Bounded prior history (Phase 15 contract §8) — only sent to the model
  // when continuing an existing conversation.
  const historyMessages = existingConversation
    ? (await listRecentMessages(existingConversation.id, HISTORY_WINDOW)).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    : [];

  let answer: string;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  try {
    const result = await generateText({
      model,
      system: AI_STAFF_COPILOT_SYSTEM_PROMPT("the courses you own", capabilityContext),
      messages: [...historyMessages, { role: "user", content: query }],
    });
    answer = result.text.trim();
    inputTokens = result.usage?.inputTokens;
    outputTokens = result.usage?.outputTokens;
  } catch (err) {
    console.error("[ai-runtime] instructor copilot generation failed", err);
    await executionTracker.markFailed(err);
    return Response.json(
      { error: "AI failed to generate a response. Please try again." },
      { status: 502 }
    );
  }

  await incrementAiUsage(user.id);
  await executionTracker.markSucceeded({ inputTokens, outputTokens });

  if (conversationId && executionId) {
    try {
      await persistMessage(conversationId, "assistant", answer);
      await recordUsageEvent(
        { tenantId: user.tenantId, userId: user.id },
        {
          executionId,
          operation: "capability.instructor.copilot",
          provider,
          model: modelId,
          inputTokens,
          outputTokens,
        }
      );
    } catch (err) {
      console.error("[ai-runtime] Failed to persist V2 instructor copilot conversation/usage", err);
    }
  }

  return Response.json({ answer, conversationId });
}
