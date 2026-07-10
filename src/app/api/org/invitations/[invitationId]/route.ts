import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";

async function requireOrgAdmin(userId: string) {
  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN" || !dbUser.tenantId) return null;
  return dbUser as { id: string; role: "ORG_ADMIN"; tenantId: string };
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ invitationId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await requireOrgAdmin(userId);
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { invitationId } = await params;

  const invitation = await db.invitation.findUnique({
    where: { id: invitationId },
    select: { id: true, tenantId: true, status: true, clerkInvitationId: true },
  });
  if (!invitation || invitation.tenantId !== dbUser.tenantId) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  if (invitation.status !== "PENDING") {
    return NextResponse.json({ error: "Invitation is no longer pending" }, { status: 409 });
  }

  const client = await clerkClient();
  await client.invitations.revokeInvitation(invitation.clerkInvitationId).catch(() => {});

  await db.invitation.update({ where: { id: invitation.id }, data: { status: "REVOKED" } });

  return NextResponse.json({ success: true });
}
