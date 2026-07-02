import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { LeaderboardClient, type LeaderboardData } from "./LeaderboardClient";

type WeeklyRow = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  currentStreak: number;
  xp: bigint;
  rank: bigint;
};

async function fetchWeekly(
  currentUserId: string,
  tenantId: string | null
): Promise<LeaderboardData> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const tenantFilter = tenantId ? Prisma.sql`AND u."tenantId" = ${tenantId}` : Prisma.sql``;

  const rows = await db.$queryRaw<WeeklyRow[]>(
    Prisma.sql`
      WITH weekly_xp AS (
        SELECT
          u.id,
          u.name,
          u."avatarUrl",
          u."currentStreak",
          COALESCE(SUM(t.amount), 0) AS xp
        FROM "User" u
        LEFT JOIN "XPTransaction" t
          ON t."userId" = u.id AND t."createdAt" >= ${sevenDaysAgo}
        WHERE 1=1 ${tenantFilter}
        GROUP BY u.id, u.name, u."avatarUrl", u."currentStreak"
        HAVING COALESCE(SUM(t.amount), 0) > 0 OR u.id = ${currentUserId}
      ),
      ranked AS (
        SELECT *, RANK() OVER (ORDER BY xp DESC) AS rank
        FROM weekly_xp
      )
      SELECT * FROM ranked
      WHERE rank <= 50 OR id = ${currentUserId}
      ORDER BY rank ASC
    `
  );

  const toEntry = (r: WeeklyRow) => ({
    id: r.id,
    name: r.name,
    avatarUrl: r.avatarUrl,
    currentStreak: r.currentStreak,
    xp: Number(r.xp),
    rank: Number(r.rank),
  });

  const entries = rows.filter((r) => Number(r.rank) <= 50).map(toEntry);
  const meRow = rows.find((r) => r.id === currentUserId);
  const currentUserEntry = meRow ? toEntry(meRow) : null;
  const inTop50 = entries.find((e) => e.id === currentUserId);

  return { entries, currentUserEntry: inTop50 ?? currentUserEntry };
}

async function fetchAllTime(
  currentUserId: string,
  tenantId: string | null
): Promise<LeaderboardData> {
  const where = tenantId ? { tenantId } : {};

  const top50 = await db.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      xpTotal: true,
      currentStreak: true,
    },
    orderBy: { xpTotal: "desc" },
    take: 50,
  });

  const entries = top50.map((u, i) => ({ ...u, xp: u.xpTotal, rank: i + 1 }));
  const inTop50 = entries.find((e) => e.id === currentUserId);

  let currentUserEntry = inTop50 ?? null;
  if (!inTop50) {
    const me = await db.user.findUnique({
      where: { id: currentUserId },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        xpTotal: true,
        currentStreak: true,
      },
    });
    if (me) {
      const above = await db.user.count({
        where: { ...where, xpTotal: { gt: me.xpTotal } },
      });
      currentUserEntry = { ...me, xp: me.xpTotal, rank: above + 1 };
    }
  }

  return { entries, currentUserEntry };
}

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
