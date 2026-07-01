"use client";

import { PLAN_LIMITS } from "@/constants/plans";
import type { Plan } from "@/generated/prisma/enums";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export function usePlan() {
  const { dbUser } = useCurrentUser();
  const plan: Plan = dbUser?.plan ?? "FREE";
  const limits = PLAN_LIMITS[plan];

  return {
    plan,
    limits,
    isFreePlan: plan === "FREE",
    canUseAI: limits.aiCallsPerMonth > 0,
    aiCallsRemaining: dbUser ? Math.max(0, limits.aiCallsPerMonth - dbUser.aiCallsUsed) : 0,
  };
}
