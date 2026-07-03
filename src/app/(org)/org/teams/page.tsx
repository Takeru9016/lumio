import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

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

  const [teams, tenant] = await Promise.all([
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
      select: { seatCount: true, seatLimit: true },
    }),
  ]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold font-heading text-text-primary">Teams</h1>
        <p className="text-sm text-text-muted mt-1">
          Organize members into teams to assign mandatory training.
        </p>
      </div>

      <TeamsClient initialTeams={teams} seatCount={tenant.seatCount} seatLimit={tenant.seatLimit} />
    </div>
  );
}
