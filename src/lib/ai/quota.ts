import { db } from "@/lib/db";
import { PLAN_LIMITS } from "@/constants/plans";
import type { Plan } from "@/generated/prisma/enums";

/**
 * Checks a user's monthly AI quota and atomically increments usage when allowed.
 * Enterprise (Infinity limit) always passes without incrementing a bounded counter.
 */
export async function checkAndIncrementQuota(
  userId: string,
  plan: Plan,
): Promise<{ allowed: boolean; remaining: number }> {
  const limit = PLAN_LIMITS[plan].aiCallsPerMonth;

  if (limit === Infinity) {
    return { allowed: true, remaining: Infinity };
  }

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { aiCallsUsed: true },
  });

  if (!user || user.aiCallsUsed >= limit) {
    return { allowed: false, remaining: 0 };
  }

  const updated = await db.user.update({
    where: { clerkId: userId },
    data: { aiCallsUsed: { increment: 1 } },
    select: { aiCallsUsed: true },
  });

  return { allowed: true, remaining: limit - updated.aiCallsUsed };
}
