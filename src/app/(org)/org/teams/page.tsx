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

  const [teams, tenant, pendingInvitations, activeMemberCount, jobRoles, userJobRoles] =
    await Promise.all([
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
      // Phase 19 — tenant's JobRole catalog, for the per-member "Capability role" control.
      db.jobRole.findMany({
        where: { tenantId: dbUser.tenantId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      db.userJobRole.findMany({
        where: { tenantId: dbUser.tenantId, user: { deletedAt: null } },
        select: { userId: true, roleId: true, isPrimary: true, role: { select: { name: true } } },
      }),
    ]);

  // Flat, userId-keyed map — a user appearing in multiple teams must show the
  // same capability roles in every row, not be looked up per-team.
  const userRolesMap: Record<string, { roleId: string; roleName: string; isPrimary: boolean }[]> =
    {};
  for (const ujr of userJobRoles) {
    if (!userRolesMap[ujr.userId]) userRolesMap[ujr.userId] = [];
    userRolesMap[ujr.userId].push({
      roleId: ujr.roleId,
      roleName: ujr.role.name,
      isPrimary: ujr.isPrimary,
    });
  }

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
          jobRoles={jobRoles}
          userRolesMap={userRolesMap}
        />
      </Suspense>
    </div>
  );
}
