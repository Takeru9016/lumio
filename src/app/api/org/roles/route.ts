import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  createJobRole,
  listJobRoles,
  RoleManagementError,
} from "@/lib/domain/capability/roleManagement";

async function resolveOrgAdminCtx() {
  const ctx = await requireAuthContext();
  requireTenant(ctx);
  requireRole(ctx, ["ORG_ADMIN"]);
  return ctx;
}

export async function GET(_req: Request) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const roles = await listJobRoles(ctx);
    return Response.json({ roles });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles] Failed to list roles", err);
    return Response.json({ error: "Failed to list roles" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await resolveOrgAdminCtx();
    const body = await req.json();
    const role = await createJobRole(ctx, body);
    return Response.json(role, { status: 201 });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RoleManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[org/roles] Failed to create role", err);
    return Response.json({ error: "Failed to create role" }, { status: 500 });
  }
}
