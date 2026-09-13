import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { listManageableKnowledgeDocuments } from "@/lib/domain/knowledge/management";

/**
 * Phase 14 — staff Knowledge management listing. Deliberately a separate
 * path from GET /api/knowledge/documents (Phase 8's Course Creator picker),
 * so that route never needs role-based branching and stays byte-for-byte
 * unchanged. Unlike the picker, this returns every status (PENDING/
 * PROCESSING/READY/ERROR) and is scoped by role, not by canReadKnowledgeDocument:
 * INSTRUCTOR sees only documents they created themselves; ORG_ADMIN sees
 * every document in their tenant. SUPER_ADMIN and STUDENT are forbidden —
 * no shortcut, per the locked Phase 14 role correction.
 */
export async function GET(_req: Request) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["INSTRUCTOR", "ORG_ADMIN"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  try {
    const documents = await listManageableKnowledgeDocuments(ctx);
    return Response.json({ documents });
  } catch (err) {
    console.error("[knowledge] Failed to list manageable documents", err);
    return Response.json({ error: "Failed to load documents" }, { status: 500 });
  }
}
