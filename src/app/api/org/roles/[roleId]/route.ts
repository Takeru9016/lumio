import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  deleteJobRole,
  getJobRoleDetail,
  RoleManagementError,
  updateJobRole,
} from "@/lib/domain/capability/roleManagement";

async function resolveOrgAdminCtx() {
  const ctx = await requireAuthContext();
  requireTenant(ctx);
  requireRole(ctx, ["ORG_ADMIN"]);
  return ctx;
}

export async function GET(_req: Request, { params }: { params: Promise<{ roleId: string }> }) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId } = await params;
    const role = await getJobRoleDetail(ctx, roleId);
    return Response.json(role);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId] Failed to get role", err);
    return Response.json({ error: "Failed to get role" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ roleId: string }> }) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId } = await params;
    const body = await req.json();
    const role = await updateJobRole(ctx, roleId, body);
    return Response.json(role);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId] Failed to update role", err);
    return Response.json({ error: "Failed to update role" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ roleId: string }> }) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const { roleId } = await params;
    await deleteJobRole(ctx, roleId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles/:roleId] Failed to delete role", err);
    return Response.json({ error: "Failed to delete role" }, { status: 500 });
  }
}
