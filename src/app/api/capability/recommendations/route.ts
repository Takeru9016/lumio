import { AuthContextError, requireAuthContext, requireTenant } from "@/lib/auth/context";
import { getRecommendedLearning } from "@/lib/domain/capability/recommendations";

/**
 * Read-only recommendation endpoint (Phase 6 locked contract, §K). Self-
 * scoped only — userId/tenantId always come from the resolved AuthContext,
 * never from a query parameter. No POST/PUT/PATCH/DELETE: recommendations
 * are computed, never mutated or persisted.
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
    const { recommendations } = await getRecommendedLearning(ctx);
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
