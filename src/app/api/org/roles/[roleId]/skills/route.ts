import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { addRoleSkill, RoleManagementError } from "@/lib/domain/capability/roleManagement";

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
    const roleSkill = await addRoleSkill(ctx, roleId, body);
    return Response.json(roleSkill, { status: 201 });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId/skills] Failed to add role skill", err);
    return Response.json({ error: "Failed to add skill requirement" }, { status: 500 });
  }
}
