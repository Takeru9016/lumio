import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib";

type WeeklyRow = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  currentStreak: number;
  xp: bigint;
  rank: bigint;
};

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, tenantId: true },
  });
  if (!dbUser) return Response.json({ error: "User not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope") ?? "platform";
  const period = searchParams.get("period") ?? "weekly";

  const tenantId = scope === "org" ? (dbUser.tenantId ?? null) : null;

  if (period === "alltime") {
    const where = tenantId ? { tenantId } : {};

    const top50 = await db.user.findMany({
      where,
      select: { id: true, name: true, avatarUrl: true, xpTotal: true, currentStreak: true },
      orderBy: { xpTotal: "desc" },
      take: 50,
    });

    const entries = top50.map((u, i) => ({ ...u, xp: u.xpTotal, rank: i + 1 }));
    const inTop50 = entries.find((e) => e.id === dbUser.id);

    let currentUserEntry = inTop50 ?? null;
    if (!inTop50) {
      const me = await db.user.findUnique({
        where: { id: dbUser.id },
        select: { id: true, name: true, avatarUrl: true, xpTotal: true, currentStreak: true },
      });
      if (me) {
        const above = await db.user.count({ where: { ...where, xpTotal: { gt: me.xpTotal } } });
        currentUserEntry = { ...me, xp: me.xpTotal, rank: above + 1 };
      }
    }

    return Response.json({ entries, currentUserId: dbUser.id, currentUserEntry });
  }

  // Weekly: sum XPTransaction amounts from last 7 days
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
        HAVING COALESCE(SUM(t.amount), 0) > 0 OR u.id = ${dbUser.id}
      ),
      ranked AS (
        SELECT *, RANK() OVER (ORDER BY xp DESC) AS rank
        FROM weekly_xp
      )
      SELECT * FROM ranked
      WHERE rank <= 50 OR id = ${dbUser.id}
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
  const meRow = rows.find((r) => r.id === dbUser.id);
  const currentUserEntry = meRow ? toEntry(meRow) : null;
  const inTop50 = entries.find((e) => e.id === dbUser.id);

  return Response.json({
    entries,
    currentUserId: dbUser.id,
    currentUserEntry: inTop50 ?? currentUserEntry,
  });
}
