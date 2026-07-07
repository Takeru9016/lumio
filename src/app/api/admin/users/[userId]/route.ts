import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import type { Plan, Role } from "@/generated/prisma/enums";
import { logAdminAction } from "@/lib/admin-audit";
import { db } from "@/lib/db";

const VALID_ROLES = new Set<Role>(["STUDENT", "INSTRUCTOR", "ORG_ADMIN", "SUPER_ADMIN"]);
const VALID_PLANS = new Set<Plan>(["FREE", "STARTER", "PRO", "ENTERPRISE"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actor = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, role: true },
  });
  if (!actor || actor.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = await params;
  const body = (await req.json().catch(() => null)) as { role?: Role; plan?: Plan } | null;

  if (!body || (body.role === undefined && body.plan === undefined)) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  if (body.role !== undefined && !VALID_ROLES.has(body.role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  if (body.plan !== undefined && !VALID_PLANS.has(body.plan)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: {
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.plan !== undefined ? { plan: body.plan } : {}),
    },
    select: { id: true, role: true, plan: true },
  });

  if (body.role !== undefined) {
    await logAdminAction(actor.id, "USER_ROLE_CHANGED", "User", userId, { role: body.role });
  }
  if (body.plan !== undefined) {
    await logAdminAction(actor.id, "USER_PLAN_CHANGED", "User", userId, { plan: body.plan });
  }

  return NextResponse.json({ success: true, user: updated });
}
