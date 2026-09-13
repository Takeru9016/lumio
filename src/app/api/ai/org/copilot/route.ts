import { auth } from "@clerk/nextjs/server";
import { generateText } from "ai";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { AI_STAFF_COPILOT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
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
import {
  buildOrganizationCopilotContext,
  OrganizationCopilotLearnerNotFoundError,
} from "@/lib/domain/capability/organizationCopilotContext";
import { orgCopilotRatelimit } from "@/lib/ratelimit";

const MAX_QUERY_LENGTH = 2000;

// .strict() rejects any unexpected field outright (tenantId/userId/role/plan/
// etc.) — the only identity-like field the caller may ever supply is
// learnerId, and it is never used for a database lookup (see
// organizationCopilotContext.ts) — only to filter the already-authorized page.
const requestSchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    learnerId: z.string().min(1).optional(),
  })
  .strict();

/**
 * ORG_ADMIN-facing Capability Copilot (Phase 13 locked contract) —
 * explains the capability state of the organisation's own tenant. Deliberately
 * NOT AI Search: no buildAIContext, no searchKnowledge, no Knowledge
 * retrieval, no citations. Reuses the COPILOT surface and the existing
 * tenant-wide boundary from Phase 9's getOrganizationCapabilityReport() —
 * never re-derived here.
 */
export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, orgCopilotRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  if (!user.tenantId) {
    return Response.json({ error: "No organisation found" }, { status: 400 });
  }

  // Phase 13 locked scope: ORG_ADMIN only. STUDENT/INSTRUCTOR/SUPER_ADMIN
  // all rejected — no shortcut for SUPER_ADMIN (see docs/V2_ROADMAP.md,
  // Phase 13).
  if (user.role !== "ORG_ADMIN") {
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
  const { query, learnerId } = parsed.data;

  const surface = "COPILOT" as const;
  assertActionAllowed(surface, "GENERATE");

  let capabilityContext: Awaited<ReturnType<typeof buildOrganizationCopilotContext>>;
  try {
    capabilityContext = await buildOrganizationCopilotContext(
      { userId: user.id, clerkId: userId as string, tenantId: user.tenantId, role: user.role },
      { learnerId }
    );
  } catch (err) {
    if (err instanceof OrganizationCopilotLearnerNotFoundError) {
      return Response.json(
        { error: "Learner not found in your capability report" },
        { status: 404 }
      );
    }
    throw err;
  }

  const { model, provider, modelId } = modelFor(surface);

  let conversationId: string | undefined;
  let executionId: string | undefined;
  const startedAt = Date.now();
  try {
    const conversation = await createConversation(
      { tenantId: user.tenantId, userId: user.id },
      { surface, contextMetadata: { query, learnerId } }
    );
    conversationId = conversation.id;
    const execution = await startExecution(
      { tenantId: user.tenantId, userId: user.id },
      { model: modelId, provider, operation: "capability.org.copilot", conversationId }
    );
    executionId = execution.id;
    await persistMessage(conversationId, "user", query);
  } catch (err) {
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
      system: AI_STAFF_COPILOT_SYSTEM_PROMPT("your organization", capabilityContext),
      prompt: query,
    });
    answer = result.text.trim();
    inputTokens = result.usage?.inputTokens;
    outputTokens = result.usage?.outputTokens;
  } catch (err) {
    console.error("[ai-runtime] org copilot generation failed", err);
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
          operation: "capability.org.copilot",
          provider,
          model: modelId,
          inputTokens,
          outputTokens,
        }
      );
    } catch (err) {
      console.error("[ai-runtime] Failed to persist V2 org copilot conversation/usage", err);
    }
  }

  return Response.json({ answer });
}
