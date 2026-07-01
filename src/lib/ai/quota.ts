import { db } from "@/lib/db";
import { PLAN_LIMITS } from "@/constants/plans";
import type { Plan } from "@/generated/prisma/enums";

/**
 * Checks a user's monthly AI quota ceiling WITHOUT incrementing usage.
 * Enterprise (Infinity limit) always passes.
 * @param userId Clerk user id
 */
export async function checkAiQuota(
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

  return { allowed: true, remaining: limit - user.aiCallsUsed };
}

/**
 * Atomically increments a user's AI usage counter.
 * Call this only AFTER a successful LLM call.
 * @param userId DB User.id (primary key), not the Clerk id
 */
export async function incrementAiUsage(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { aiCallsUsed: { increment: 1 } },
  });
}
