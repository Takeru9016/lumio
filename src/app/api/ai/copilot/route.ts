import { auth } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { AI_COPILOT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { createExecutionTracker } from "@/lib/ai/runtime/execution";
import {
  createConversation,
  getConversationForContinuation,
  listRecentMessages,
  persistMessage,
  readConversationRoleId,
  recordUsageEvent,
  startExecution,
} from "@/lib/ai/runtime/persistence";
import { assertActionAllowed } from "@/lib/ai/runtime/policy";
import { modelFor } from "@/lib/ai/runtime/provider";
import { buildCopilotContext } from "@/lib/domain/capability/copilotContext";
import { getUserAssignedRoles } from "@/lib/domain/capability/gaps";
import { copilotRatelimit } from "@/lib/ratelimit";

const MAX_QUERY_LENGTH = 2000;
const SURFACE_MARKER = "STUDENT_COPILOT" as const;
// Model-input bound only (Phase 15 contract §8) — persisted history is never
// deleted or summarized; only what's sent to generateText is bounded.
const HISTORY_WINDOW = 10;

// .strict() rejects any unexpected field outright (tenantId/userId/role/plan/
// capability state/etc.) — the caller never gets to influence identity or
// scope beyond the natural-language question itself. Student Copilot never
// accepts learnerId — it has no concept of "another learner" to scope to.
const copilotRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    conversationId: z.string().min(1).optional(),
    roleId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Learner-facing AI Capability Copilot (Phase 12 locked contract, extended
 * with Phase 15 conversation continuity) — explains the caller's own
 * already-computed capability state. Deliberately NOT AI Search: no
 * buildAIContext, no searchKnowledge, no Knowledge retrieval, no citations.
 * Structurally incapable of becoming a second Search implementation because
 * it never imports either.
 */
export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, copilotRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  if (!user.tenantId) {
    return Response.json({ error: "No organisation found" }, { status: 400 });
  }

  // Phase 12 locked scope: STUDENT only. Staff roles do not get Copilot
  // access even though they have a valid user record (see docs/V2_ROADMAP.md,
  // Phase 12).
  if (user.role !== "STUDENT") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = copilotRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid query" }, { status: 400 });
  }
  const { query, conversationId: suppliedConversationId, roleId: requestedRoleId } = parsed.data;

  const ctx = {
    userId: user.id,
    clerkId: userId as string,
    tenantId: user.tenantId,
    role: user.role,
  };

  // Phase 21: an explicit roleId must belong to the caller's own
  // UserJobRole set — computeCapabilityGap only validates tenant match, not
  // ownership (see gaps.ts's SECURITY NOTE), so this route owns that check.
  // An unheld roleId is rejected outright, never silently degraded to the
  // primary role — a silent fallback would look like a working role switch
  // that actually isn't.
  let roleId: string | undefined;
  if (requestedRoleId) {
    const assignedRoles = await getUserAssignedRoles(ctx);
    if (!assignedRoles.some((r) => r.roleId === requestedRoleId)) {
      return Response.json({ error: "You don't hold that role" }, { status: 403 });
    }
    roleId = requestedRoleId;
  }

  const surface = "COPILOT" as const;
  // Always passes today (COPILOT.GENERATE is true) — asserted explicitly
  // rather than assumed, matching every other AI route's convention.
  assertActionAllowed(surface, "GENERATE");

  // Phase 15: resolve a supplied conversationId for continuation. Scoped to
  // {id, tenantId, userId} + the STUDENT_COPILOT surface marker in one call —
  // any mismatch (not found, wrong tenant/user, wrong/missing surface) comes
  // back as the same null, which this route always turns into the same 404
  // (never distinguishing why to the caller).
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
    // Phase 21: a conversation's role scope, once set at creation, is fixed
    // for its lifetime — mirrors Instructor Copilot's learnerId lock. A
    // continuation attempting a different role (including switching to/from
    // no role) is rejected rather than silently reusing stale role context.
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
  const capabilityContext = await buildCopilotContext(ctx, roleId);

  const { model, provider, modelId } = modelFor(surface);

  let conversationId: string | undefined = existingConversation?.id;
  let executionId: string | undefined;
  const startedAt = Date.now();
  try {
    if (!conversationId) {
      const conversation = await createConversation(
        { tenantId: user.tenantId, userId: user.id },
        { surface, contextMetadata: { surface: SURFACE_MARKER, query, roleId } }
      );
      conversationId = conversation.id;
    }
    const execution = await startExecution(
      { tenantId: user.tenantId, userId: user.id },
      { model: modelId, provider, operation: "capability.copilot", conversationId }
    );
    executionId = execution.id;
    await persistMessage(conversationId, "user", query);
  } catch (err) {
    // Persistence setup failing must not block the Copilot response — same
    // best-effort posture as Search/Tutor (docs/V2_AI_ARCHITECTURE.md,
    // "Error handling").
    console.error("[ai-runtime] Failed to start V2 conversation/execution", err);
    conversationId = existingConversation?.id;
    executionId = undefined;
  }

  const executionTracker = createExecutionTracker(executionId, startedAt);

  // Bounded prior history (Phase 15 contract §8) — only sent to the model
  // when continuing an existing conversation; a brand-new conversation has
  // no prior turns. System prompt is rebuilt fresh above/below regardless.
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
      system: AI_COPILOT_SYSTEM_PROMPT(capabilityContext),
      messages: [...historyMessages, { role: "user", content: query }],
    });
    answer = result.text.trim();
    inputTokens = result.usage?.inputTokens;
    outputTokens = result.usage?.outputTokens;
  } catch (err) {
    console.error("[ai-runtime] copilot generation failed", err);
    await executionTracker.markFailed(err);
    return Response.json(
      { error: "AI failed to generate a response. Please try again." },
      { status: 502 }
    );
  }

  // Unconditional, exactly like Search/Tutor — the model call already
  // succeeded by this point; quota accounting doesn't depend on V2 bookkeeping.
  await incrementAiUsage(user.id);
  await executionTracker.markSucceeded({ inputTokens, outputTokens });

  // V2 persistence: additive, best-effort — never fails a response that has
  // already succeeded. No AISourceCitation rows — Copilot has no citations.
  if (conversationId && executionId) {
    try {
      await persistMessage(conversationId, "assistant", answer);
      await recordUsageEvent(
        { tenantId: user.tenantId, userId: user.id },
        {
          executionId,
          operation: "capability.copilot",
          provider,
          model: modelId,
          inputTokens,
          outputTokens,
        }
      );
    } catch (err) {
      console.error("[ai-runtime] Failed to persist V2 copilot conversation/usage", err);
    }
  }

  return Response.json({ answer, conversationId });
}
