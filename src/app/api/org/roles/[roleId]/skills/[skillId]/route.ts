import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  RoleManagementError,
  removeRoleSkill,
  updateRoleSkill,
} from "@/lib/domain/capability/roleManagement";

async function resolveOrgAdminCtx() {
  const ctx = await requireAuthContext();
  requireTenant(ctx);
  requireRole(ctx, ["ORG_ADMIN"]);
  return ctx;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ roleId: string; skillId: string }> }
) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId, skillId } = await params;
    const body = await req.json();
    const roleSkill = await updateRoleSkill(ctx, roleId, skillId, body);
    return Response.json(roleSkill);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId/skills/:skillId] Failed to update role skill", err);
    return Response.json({ error: "Failed to update skill requirement" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ roleId: string; skillId: string }> }
) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId, skillId } = await params;
    await removeRoleSkill(ctx, roleId, skillId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId/skills/:skillId] Failed to remove role skill", err);
    return Response.json({ error: "Failed to remove skill requirement" }, { status: 500 });
  }
}
