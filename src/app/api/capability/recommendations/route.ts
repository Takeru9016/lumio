import { AuthContextError, requireAuthContext, requireTenant } from "@/lib/auth/context";
import { getUserAssignedRoles } from "@/lib/domain/capability/gaps";
import { getRecommendedLearning } from "@/lib/domain/capability/recommendations";

/**
 * Read-only recommendation endpoint (Phase 6 locked contract, §K). Self-
 * scoped only — userId/tenantId always come from the resolved AuthContext,
 * never from a query parameter. No POST/PUT/PATCH/DELETE: recommendations
 * are computed, never mutated or persisted.
 *
 * Phase 21: an optional `?roleId=` scopes recommendations to one of the
 * caller's own roles (never another user's) — omitted, it keeps the exact
 * Phase 6 primary-role default. Ownership is validated the same way the
 * Student Copilot route does: reject outright on an unheld roleId, never
 * silently fall back to primary.
 */
export async function GET(req: Request) {
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

  const requestedRoleId = new URL(req.url).searchParams.get("roleId") ?? undefined;
  let roleId: string | undefined;
  if (requestedRoleId) {
    const assignedRoles = await getUserAssignedRoles(ctx);
    if (!assignedRoles.some((r) => r.roleId === requestedRoleId)) {
      return Response.json({ error: "You don't hold that role" }, { status: 403 });
    }
    roleId = requestedRoleId;
  }

  try {
    const { recommendations } = await getRecommendedLearning(ctx, roleId);
    return Response.json({
      recommendations: recommendations.map(({ courseId, courseTitle, reasonSkills }) => ({
        courseId,
        courseTitle,
        reasonSkills,
      })),
    });
  } catch (err) {
    console.error("[capability] Failed to compute recommendations", err);
    return Response.json({ error: "Failed to compute recommendations" }, { status: 500 });
  }
}
