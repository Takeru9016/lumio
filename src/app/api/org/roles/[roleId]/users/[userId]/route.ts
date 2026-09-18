import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  changePrimaryUserJobRole,
  RoleManagementError,
  removeUserJobRole,
} from "@/lib/domain/capability/roleManagement";

async function resolveOrgAdminCtx() {
  const ctx = await requireAuthContext();
  requireTenant(ctx);
  requireRole(ctx, ["ORG_ADMIN"]);
  return ctx;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ roleId: string; userId: string }> }
) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId, userId } = await params;
    const body = await req.json();
    if (body?.isPrimary !== true) {
      return Response.json({ error: "isPrimary must be true" }, { status: 400 });
    }
    const assignment = await changePrimaryUserJobRole(ctx, roleId, userId);
    return Response.json(assignment);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId/users/:userId] Failed to change primary role", err);
    return Response.json({ error: "Failed to change primary role" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ roleId: string; userId: string }> }
) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId, userId } = await params;
    await removeUserJobRole(ctx, roleId, userId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId/users/:userId] Failed to remove role assignment", err);
    return Response.json({ error: "Failed to remove role assignment" }, { status: 500 });
  }
}
