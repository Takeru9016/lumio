import { auth } from "@clerk/nextjs/server";

import { db, awardXP, updateStreak, XP_EVENTS } from "@/lib";

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: {
      id: true,
      clerkId: true,
      email: true,
      name: true,
      avatarUrl: true,
      role: true,
      plan: true,
      aiCallsUsed: true,
      aiQuotaResetAt: true,
      xpTotal: true,
      currentStreak: true,
      longestStreak: true,
      lastActiveDate: true,
      tenantId: true,
      createdAt: true,
    },
  });

  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const today = new Date();
  const isFirstCallToday =
    !user.lastActiveDate || !isSameDay(user.lastActiveDate, today);

  if (isFirstCallToday) {
    await Promise.all([
      updateStreak(user.id),
      awardXP(user.id, "DAILY_LOGIN", XP_EVENTS.DAILY_LOGIN),
    ]);
  }

  return Response.json(user);
}
