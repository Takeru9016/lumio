import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  getInstructorCapabilityReport,
  InstructorCapabilityCursorError,
} from "@/lib/domain/capability/instructorReport";

const MAX_LIMIT = 100;

/**
 * INSTRUCTOR-only capability overview, scoped to students enrolled in
 * courses this instructor owns (Phase 11 locked contract). Instructor and
 * tenant always come from the resolved AuthContext, never from the query
 * string. No new authorization primitive — reuses requireRole() exactly as
 * /api/org/capability (Phase 9) does.
 */
export async function GET(req: Request) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["INSTRUCTOR"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const limitParam = searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    }
    limit = parsed;
  }

  try {
    const page = await getInstructorCapabilityReport(ctx.userId, ctx.tenantId, { cursor, limit });
    return Response.json(page);
  } catch (err) {
    if (err instanceof InstructorCapabilityCursorError) {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }
    console.error("[instructor/capability] Failed to compute capability report", err);
    return Response.json({ error: "Failed to load capability report" }, { status: 500 });
  }
}
