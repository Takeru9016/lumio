import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { assignUserJobRole, RoleManagementError } from "@/lib/domain/capability/roleManagement";

async function resolveOrgAdminCtx() {
  const ctx = await requireAuthContext();
  requireTenant(ctx);
  requireRole(ctx, ["ORG_ADMIN"]);
  return ctx;
}

export async function POST(req: Request, { params }: { params: Promise<{ roleId: string }> }) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId } = await params;
    const body = await req.json();
    const assignment = await assignUserJobRole(ctx, roleId, body);
    return Response.json(assignment, { status: 201 });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId/users] Failed to assign role", err);
    return Response.json({ error: "Failed to assign role" }, { status: 500 });
  }
}
