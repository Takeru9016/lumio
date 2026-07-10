import { auth } from "@clerk/nextjs/server";
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

export async function POST(req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await requireOrgAdmin(userId);
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { teamId } = await params;
  const { email } = await req.json();
  if (typeof email !== "string" || email.trim().length === 0) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const team = await db.team.findUnique({ where: { id: teamId }, select: { tenantId: true } });

  if (!team || team.tenantId !== dbUser.tenantId) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  // No seat-limit check here: this only assigns an *existing* tenant member (verified
  // below) to a team. They already occupy a seat — team membership doesn't consume
  // another one. Seat limits are enforced where new members actually join the tenant
  // (POST /api/org/invitations).
  const member = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, name: true, email: true, role: true, tenantId: true, deletedAt: true },
  });

  if (!member || member.tenantId !== dbUser.tenantId || member.deletedAt) {
    return NextResponse.json(
      { error: "No active member with that email in your organization" },
      { status: 404 }
    );
  }

  const existing = await db.teamMember.findUnique({
    where: { userId_teamId: { userId: member.id, teamId } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ error: "Already a member of this team" }, { status: 409 });
  }

  await db.teamMember.create({ data: { userId: member.id, teamId } });

  return NextResponse.json(
    { id: member.id, name: member.name, email: member.email, role: member.role },
    { status: 201 }
  );
}
