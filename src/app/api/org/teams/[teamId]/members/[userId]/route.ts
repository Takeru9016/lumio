import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";

async function requireOrgAdmin(clerkUserId: string) {
  const dbUser = await db.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN" || !dbUser.tenantId) return null;
  return dbUser as { id: string; role: "ORG_ADMIN"; tenantId: string };
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ teamId: string; userId: string }> }
) {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await requireOrgAdmin(clerkUserId);
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { teamId, userId } = await params;

  const team = await db.team.findUnique({ where: { id: teamId }, select: { tenantId: true } });
  if (!team || team.tenantId !== dbUser.tenantId) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  await db.teamMember.deleteMany({ where: { teamId, userId } });

  return NextResponse.json({ success: true });
}
