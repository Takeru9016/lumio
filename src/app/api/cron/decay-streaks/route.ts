import type { NextRequest } from "next/server";
import { db } from "@/lib/db";

/**
 * Vercel Cron target (see vercel.json). Vercel automatically sends
 * `Authorization: Bearer $CRON_SECRET` on scheduled invocations when
 * CRON_SECRET is set as a project env var.
 */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Mirrors the isSameDay/isYesterday logic in src/lib/streak.ts: a streak stays
  // intact if the user was active today or yesterday. Anything older is broken
  // and would otherwise sit at a stale non-zero value until the user's next visit.
  const startOfYesterday = new Date();
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  startOfYesterday.setHours(0, 0, 0, 0);

  const { count } = await db.user.updateMany({
    where: {
      currentStreak: { gt: 0 },
      OR: [{ lastActiveDate: null }, { lastActiveDate: { lt: startOfYesterday } }],
    },
    data: { currentStreak: 0 },
  });

  return Response.json({ reset: count });
}
