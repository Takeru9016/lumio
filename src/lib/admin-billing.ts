import { db } from "@/lib/db";

export interface PlatformBillingData {
  tenantsByPlan: { plan: string; count: number }[];
  usersByPlan: { plan: string; count: number }[];
  subscriptionStatusBreakdown: { status: string; count: number }[];
}

export async function getPlatformBillingData(): Promise<PlatformBillingData> {
  const [tenantsByPlan, usersByPlan, subscriptionStatusBreakdown] = await Promise.all([
    db.tenant.groupBy({ by: ["plan"], _count: { _all: true } }),
    db.user.groupBy({ by: ["plan"], _count: { _all: true } }),
    db.user.groupBy({
      by: ["subscriptionStatus"],
      _count: { _all: true },
      where: { subscriptionStatus: { not: null } },
    }),
  ]);

  return {
    tenantsByPlan: tenantsByPlan.map((p) => ({ plan: p.plan, count: p._count._all })),
    usersByPlan: usersByPlan.map((p) => ({ plan: p.plan, count: p._count._all })),
    subscriptionStatusBreakdown: subscriptionStatusBreakdown.map((s) => ({
      status: s.subscriptionStatus ?? "UNKNOWN",
      count: s._count._all,
    })),
  };
}
