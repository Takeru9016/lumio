import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";

const INVITABLE_ROLES = new Set(["STUDENT", "INSTRUCTOR"]);
const INVITATION_EXPIRES_IN_DAYS = 30;

async function requireOrgAdmin(userId: string) {
  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN" || !dbUser.tenantId) return null;
  return dbUser as { id: string; role: "ORG_ADMIN"; tenantId: string };
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await requireOrgAdmin(userId);
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const invitations = await db.invitation.findMany({
    where: { tenantId: dbUser.tenantId, status: "PENDING" },
    select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(invitations);
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await requireOrgAdmin(userId);
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { email, role } = await req.json();
  if (typeof email !== "string" || email.trim().length === 0) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (typeof role !== "string" || !INVITABLE_ROLES.has(role)) {
    return NextResponse.json({ error: "Role must be STUDENT or INSTRUCTOR" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const [tenant, existingUser, existingInvitation, activeMemberCount, pendingCount] =
    await Promise.all([
      db.tenant.findUniqueOrThrow({
        where: { id: dbUser.tenantId },
        select: { seatLimit: true },
      }),
      db.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, tenantId: true },
      }),
      db.invitation.findFirst({
        where: { tenantId: dbUser.tenantId, email: normalizedEmail, status: "PENDING" },
        select: { id: true },
      }),
      // `Tenant.seatCount` is never written anywhere in this codebase — it's not a live
      // member counter, so the cap is computed from the real active-member count instead
      // (same query the org dashboard uses).
      db.user.count({ where: { tenantId: dbUser.tenantId, deletedAt: null } }),
      db.invitation.count({ where: { tenantId: dbUser.tenantId, status: "PENDING" } }),
    ]);

  if (existingUser) {
    return NextResponse.json(
      {
        error:
          existingUser.tenantId === dbUser.tenantId
            ? "This person is already a member of your organization"
            : "A user with that email already exists",
      },
      { status: 409 }
    );
  }
  if (existingInvitation) {
    return NextResponse.json(
      { error: "An invitation is already pending for this email" },
      { status: 409 }
    );
  }
  // Seats consumed by active members AND pending invitations, so an admin can't invite
  // past the cap and blow the seat count once every invite is accepted.
  if (activeMemberCount + pendingCount >= tenant.seatLimit) {
    return NextResponse.json({ error: "Seat limit reached" }, { status: 403 });
  }

  const client = await clerkClient();
  const clerkInvitation = await client.invitations.createInvitation({
    emailAddress: normalizedEmail,
    publicMetadata: { role, tenantId: dbUser.tenantId, invitedByUserId: dbUser.id },
    redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/sign-up`,
    expiresInDays: INVITATION_EXPIRES_IN_DAYS,
    notify: true,
  });

  const invitation = await db.invitation.create({
    data: {
      email: normalizedEmail,
      role: role as "STUDENT" | "INSTRUCTOR",
      clerkInvitationId: clerkInvitation.id,
      tenantId: dbUser.tenantId,
      invitedById: dbUser.id,
      expiresAt: new Date(Date.now() + INVITATION_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000),
    },
    select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
  });

  return NextResponse.json(invitation, { status: 201 });
}
