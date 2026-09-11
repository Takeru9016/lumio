import { AuthContextError, requireAuthContext, requireTenant } from "@/lib/auth/context";
import { listReadableKnowledgeDocuments } from "@/lib/domain/knowledge/listing";

/**
 * Read-only, tenant + access-scoped Knowledge document listing for picker
 * UIs (Course Creator, Phase 8 locked contract §4/§7). Self-scoped only —
 * tenantId always comes from the resolved AuthContext. No pagination or
 * search: bounded to MAX_RESULTS by listReadableKnowledgeDocuments.
 */
export async function GET(_req: Request) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  try {
    const documents = await listReadableKnowledgeDocuments(ctx);
    return Response.json({ documents });
  } catch (err) {
    console.error("[knowledge] Failed to list documents", err);
    return Response.json({ error: "Failed to list documents" }, { status: 500 });
  }
}
