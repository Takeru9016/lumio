import { listConversationsForUser } from "@/lib/ai/runtime/persistence";
import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";

const LABEL_MAX_LENGTH = 60;

function deriveLabel(contextMetadata: unknown): string {
  if (contextMetadata && typeof contextMetadata === "object" && !Array.isArray(contextMetadata)) {
    const query = (contextMetadata as Record<string, unknown>).query;
    if (typeof query === "string" && query.trim().length > 0) {
      return query.length > LABEL_MAX_LENGTH ? `${query.slice(0, LABEL_MAX_LENGTH)}…` : query;
    }
  }
  return "Conversation";
}

/**
 * Phase 15 — bounded, most-recent-first list of the caller's own
 * Organization Copilot conversations. A read, not a generation call: no
 * withAiGuards, no rate limit, no quota. Never exposes another staff
 * member's conversations, even though ORG_ADMIN has tenant-wide capability
 * report authority elsewhere (Phase 9/13) — AI conversations are private
 * per-user regardless of role (Phase 15 contract §5).
 */
export async function GET(_req: Request) {
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

  try {
    const conversations = await listConversationsForUser(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      "ORG_COPILOT"
    );
    return Response.json({
      conversations: conversations.map((c) => ({
        id: c.id,
        label: deriveLabel(c.contextMetadata),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    });
  } catch (err) {
    console.error("[ai-runtime] Failed to list Org Copilot conversations", err);
    return Response.json({ error: "Failed to load conversations" }, { status: 500 });
  }
}
