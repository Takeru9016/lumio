import { getConversationForContinuation, listRecentMessages } from "@/lib/ai/runtime/persistence";
import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";

type Params = { params: Promise<{ id: string }> };

// A display fetch, not the model-input window (Phase 15 contract §7/§10) —
// bounded only to keep the response reasonable, never to hide history.
const DISPLAY_MESSAGE_LIMIT = 200;

/**
 * Phase 15 — one Student Copilot conversation's messages, for the history
 * panel. Reuses getConversationForContinuation (same ownership + surface
 * check the continuation POST uses) so a manipulated id, another user's
 * conversation, a cross-tenant id, or a conversation belonging to a
 * different surface are all indistinguishable 404s. Never exposes
 * tenantId, AIExecution/AIUsageEvent internals, or the system prompt.
 */
export async function GET(_req: Request, { params }: Params) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["STUDENT"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { id } = await params;
  const conversation = await getConversationForContinuation(
    { tenantId: ctx.tenantId, userId: ctx.userId },
    id,
    "STUDENT_COPILOT"
  );
  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const messages = await listRecentMessages(conversation.id, DISPLAY_MESSAGE_LIMIT);

  return Response.json({
    conversation: {
      id: conversation.id,
      createdAt: conversation.createdAt,
      messages: messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    },
  });
}
