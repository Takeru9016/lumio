import { AuthContextError, requireAuthContext, requireTenant } from "@/lib/auth/context";
import { listActiveSkills } from "@/lib/domain/capability/skillListing";

/**
 * Read-only, tenant-scoped, ACTIVE-only Skill listing for picker UIs
 * (Course Creator, Phase 8 locked contract §5/§8). Self-scoped only —
 * tenantId always comes from the resolved AuthContext. No pagination or
 * search: bounded to MAX_RESULTS by listActiveSkills.
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
    const skills = await listActiveSkills(ctx);
    return Response.json({ skills });
  } catch (err) {
    console.error("[skills] Failed to list skills", err);
    return Response.json({ error: "Failed to list skills" }, { status: 500 });
  }
}
