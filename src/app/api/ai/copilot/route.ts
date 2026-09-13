import { auth } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { AI_COPILOT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { createExecutionTracker } from "@/lib/ai/runtime/execution";
import {
  createConversation,
  persistMessage,
  recordUsageEvent,
  startExecution,
} from "@/lib/ai/runtime/persistence";
import { assertActionAllowed } from "@/lib/ai/runtime/policy";
import { modelFor } from "@/lib/ai/runtime/provider";
import { buildCopilotContext } from "@/lib/domain/capability/copilotContext";
import { copilotRatelimit } from "@/lib/ratelimit";

const MAX_QUERY_LENGTH = 2000;

// .strict() rejects any unexpected field outright (tenantId/userId/role/plan/
// capability state/etc.) — the caller never gets to influence identity or
// scope beyond the natural-language question itself.
const copilotRequestSchema = z
  .object({ query: z.string().trim().min(1).max(MAX_QUERY_LENGTH) })
  .strict();

/**
 * Learner-facing AI Capability Copilot (Phase 12 locked contract) —
 * explains the caller's own already-computed capability state. Deliberately
 * NOT AI Search: no buildAIContext, no searchKnowledge, no Knowledge
 * retrieval, no citations. Structurally incapable of becoming a second
 * Search implementation because it never imports either.
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
  const { query } = parsed.data;

  const surface = "COPILOT" as const;
  // Always passes today (COPILOT.GENERATE is true) — asserted explicitly
  // rather than assumed, matching every other AI route's convention.
  assertActionAllowed(surface, "GENERATE");

  const capabilityContext = await buildCopilotContext({
    userId: user.id,
    clerkId: userId as string,
    tenantId: user.tenantId,
    role: user.role,
  });

  const { model, provider, modelId } = modelFor(surface);

  let conversationId: string | undefined;
  let executionId: string | undefined;
  const startedAt = Date.now();
  try {
    const conversation = await createConversation(
      { tenantId: user.tenantId, userId: user.id },
      { surface, contextMetadata: { query } }
    );
    conversationId = conversation.id;
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
    conversationId = undefined;
    executionId = undefined;
  }

  const executionTracker = createExecutionTracker(executionId, startedAt);

  let answer: string;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  try {
    const result = await generateText({
      model,
      system: AI_COPILOT_SYSTEM_PROMPT(capabilityContext),
      prompt: query,
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

  return Response.json({ answer });
}
