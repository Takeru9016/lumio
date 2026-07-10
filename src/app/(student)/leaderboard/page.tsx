import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { fetchAllTime, fetchWeekly } from "@/lib/leaderboard";
import { LeaderboardClient, type LeaderboardData } from "./LeaderboardClient";

export default async function LeaderboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, tenantId: true },
  });
  if (!dbUser) redirect("/sign-in");

  const [weeklyPlatform, alltimePlatform] = await Promise.all([
    fetchWeekly(dbUser.id, null),
    fetchAllTime(dbUser.id, null),
  ]);

  let weeklyOrg: LeaderboardData | undefined;
  let alltimeOrg: LeaderboardData | undefined;

  if (dbUser.tenantId) {
    [weeklyOrg, alltimeOrg] = await Promise.all([
      fetchWeekly(dbUser.id, dbUser.tenantId),
      fetchAllTime(dbUser.id, dbUser.tenantId),
    ]);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Leaderboard
        </h1>
        <p className="text-sm text-text-muted">See how you rank against other learners.</p>
      </div>

      <LeaderboardClient
        currentUserId={dbUser.id}
        hasTenant={!!dbUser.tenantId}
        weeklyPlatform={weeklyPlatform}
        alltimePlatform={alltimePlatform}
        weeklyOrg={weeklyOrg}
        alltimeOrg={alltimeOrg}
      />
    </div>
  );
}
