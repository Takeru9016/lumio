import type { Plan } from "@/generated/prisma/enums";

export type PlanLimits = {
  aiCallsPerMonth: number;
  maxCourses: number;
  maxSeats: number;
  hasCustomDomain: boolean;
  hasSSO: boolean;
};

// Postgres Int4 can't store Infinity — this is the sentinel written to
// Tenant.seatLimit for plans with unlimited seats (well above any realistic org size).
const UNLIMITED_SEAT_SENTINEL = 1_000_000;

export function seatLimitForPlan(plan: Plan): number {
  const { maxSeats } = PLAN_LIMITS[plan];
  return Number.isFinite(maxSeats) ? maxSeats : UNLIMITED_SEAT_SENTINEL;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    aiCallsPerMonth: 0,
    maxCourses: 1,
    // Non-zero so a brand-new org admin can invite a few people before needing to
    // upgrade — inviting instructors/students is core to the product, not a paid add-on.
    maxSeats: 3,
    hasCustomDomain: false,
    hasSSO: false,
  },
  STARTER: {
    aiCallsPerMonth: 50,
    maxCourses: 10,
    maxSeats: 10,
    hasCustomDomain: false,
    hasSSO: false,
  },
  PRO: {
    aiCallsPerMonth: 200,
    maxCourses: Infinity,
    maxSeats: 100,
    hasCustomDomain: true,
    hasSSO: false,
  },
  ENTERPRISE: {
    aiCallsPerMonth: Infinity,
    maxCourses: Infinity,
    maxSeats: Infinity,
    hasCustomDomain: true,
    hasSSO: true,
  },
};
