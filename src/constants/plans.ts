import type { Plan } from "@/generated/prisma/enums";

export type PlanLimits = {
  aiCallsPerMonth: number;
  maxCourses: number;
  maxSeats: number;
  hasCustomDomain: boolean;
  hasSSO: boolean;
};

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    aiCallsPerMonth: 0,
    maxCourses: 1,
    maxSeats: 0,
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
