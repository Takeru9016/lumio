import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { TeamsClient } from "@/components";
import { db } from "@/lib/db";

export default async function OrgTeamsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!dbUser.tenantId) redirect("/onboarding");

  const [teams, tenant, pendingInvitations, activeMemberCount] = await Promise.all([
    db.team.findMany({
      where: { tenantId: dbUser.tenantId },
      select: {
        id: true,
        name: true,
        members: {
          select: {
            user: { select: { id: true, name: true, email: true, role: true } },
          },
          orderBy: { joinedAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.tenant.findUniqueOrThrow({
      where: { id: dbUser.tenantId },
      select: { seatLimit: true },
    }),
    db.invitation.findMany({
      where: { tenantId: dbUser.tenantId, status: "PENDING" },
      select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    }),
    // `Tenant.seatCount` is never written anywhere in this codebase, so it isn't a live
    // member counter — the real active-member count is used instead (matches the org
    // dashboard's query in src/lib/org-dashboard.ts).
    db.user.count({ where: { tenantId: dbUser.tenantId, deletedAt: null } }),
  ]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold font-heading text-text-primary">Teams</h1>
        <p className="text-sm text-text-muted mt-1">
          Organize members into teams to assign mandatory training.
        </p>
      </div>

      <Suspense fallback={null}>
        <TeamsClient
          initialTeams={teams}
          seatCount={activeMemberCount}
          seatLimit={tenant.seatLimit}
          initialInvitations={pendingInvitations}
        />
      </Suspense>
    </div>
  );
}
