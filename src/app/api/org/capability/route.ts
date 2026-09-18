import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  getOrganizationCapabilityReport,
  OrgCapabilityCursorError,
  OrgCapabilityInvalidRoleError,
} from "@/lib/domain/capability/organizationReport";

const MAX_LIMIT = 100;

/**
 * ORG_ADMIN-only tenant-wide capability overview (Phase 9 locked contract).
 * Tenant always comes from the resolved AuthContext, never from the query
 * string. No new authorization primitive — reuses requireRole() exactly as
 * every other role-gated route does.
 */
export async function GET(req: Request) {
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

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const roleId = searchParams.get("roleId") ?? undefined;
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
    const page = await getOrganizationCapabilityReport(ctx.tenantId, { cursor, limit, roleId });
    return Response.json(page);
  } catch (err) {
    if (err instanceof OrgCapabilityCursorError) {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }
    if (err instanceof OrgCapabilityInvalidRoleError) {
      return Response.json({ error: "Role not found" }, { status: 400 });
    }
    console.error("[org/capability] Failed to compute capability report", err);
    return Response.json({ error: "Failed to load capability report" }, { status: 500 });
  }
}
