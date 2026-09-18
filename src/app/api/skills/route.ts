import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { createSkillMinimal, RoleManagementError } from "@/lib/domain/capability/roleManagement";
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

/**
 * Minimal ORG_ADMIN Skill creation (Phase 19) — name + optional description
 * only. `categoryId` is always null and `status` is always ACTIVE; category
 * management is deliberately out of scope. Required because the repository
 * had no production Skill writer before this route — without it, a new
 * tenant's skill picker (GET above) would be permanently empty.
 */
export async function POST(req: Request) {
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
    const body = await req.json();
    const skill = await createSkillMinimal(ctx, body);
    return Response.json(skill, { status: 201 });
  } catch (err) {
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[skills] Failed to create skill", err);
    return Response.json({ error: "Failed to create skill" }, { status: 500 });
  }
}
