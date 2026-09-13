import { getConversationForContinuation, listRecentMessages } from "@/lib/ai/runtime/persistence";
import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";

type Params = { params: Promise<{ id: string }> };

const DISPLAY_MESSAGE_LIMIT = 200;

/**
 * Phase 15 — one Organization Copilot conversation's messages, for the
 * history panel. Reuses getConversationForContinuation, so a manipulated
 * id, another user's conversation (including another ORG_ADMIN's — no
 * staff override, Phase 15 contract §5), a cross-tenant id, or a
 * Student/Instructor Copilot conversation reused here are all the same
 * 404. Never exposes tenantId, AIExecution/AIUsageEvent internals, or the
 * system prompt.
 */
export async function GET(_req: Request, { params }: Params) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["ORG_ADMIN"]);
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
    "ORG_COPILOT"
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
