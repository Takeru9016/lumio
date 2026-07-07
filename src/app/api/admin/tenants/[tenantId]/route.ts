import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { logAdminAction } from "@/lib/admin-audit";
import { db } from "@/lib/db";

export async function PATCH(req: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actor = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true },
  });
  if (!actor || actor.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { tenantId } = await params;
  const body = (await req.json().catch(() => null)) as { suspended?: boolean } | null;
  if (!body || typeof body.suspended !== "boolean") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const tenant = await db.tenant.update({
    where: { id: tenantId },
    data: { suspendedAt: body.suspended ? new Date() : null },
    select: { id: true, suspendedAt: true },
  });

  await logAdminAction(
    actor.id,
    body.suspended ? "TENANT_SUSPENDED" : "TENANT_REACTIVATED",
    "Tenant",
    tenantId
  );

  return NextResponse.json({ success: true, tenant });
}
