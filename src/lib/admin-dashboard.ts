import { db } from "@/lib/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlatformDashboardData {
  totalTenants: number;
  suspendedTenants: number;
  usersByRole: { role: string; count: number }[];
  coursesByStatus: { status: string; count: number }[];
  totalEnrollments: number;
  aiCallsUsedTotal: number;
  tenantsByPlan: { plan: string; count: number }[];
  newTenantsByDay: { date: string; count: number }[];
}

export async function getPlatformDashboardData(): Promise<PlatformDashboardData> {
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);

  const [
    totalTenants,
    suspendedTenants,
    usersByRole,
    coursesByStatus,
    totalEnrollments,
    aiUsage,
    tenantsByPlan,
    recentTenants,
  ] = await Promise.all([
    db.tenant.count(),
    db.tenant.count({ where: { suspendedAt: { not: null } } }),
    db.user.groupBy({ by: ["role"], _count: { _all: true } }),
    db.course.groupBy({ by: ["status"], _count: { _all: true } }),
    db.enrollment.count(),
    db.user.aggregate({ _sum: { aiCallsUsed: true } }),
    db.tenant.groupBy({ by: ["plan"], _count: { _all: true } }),
    db.tenant.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
    }),
  ]);

  const countByDate = new Map<string, number>();
  for (const t of recentTenants) {
    const key = t.createdAt.toISOString().slice(0, 10);
    countByDate.set(key, (countByDate.get(key) ?? 0) + 1);
  }
  const newTenantsByDay = Array.from({ length: 30 }, (_, i) => {
    const key = new Date(Date.now() - (29 - i) * DAY_MS).toISOString().slice(0, 10);
    return { date: key, count: countByDate.get(key) ?? 0 };
  });

  return {
    totalTenants,
    suspendedTenants,
    usersByRole: usersByRole.map((r) => ({ role: r.role, count: r._count._all })),
    coursesByStatus: coursesByStatus.map((c) => ({ status: c.status, count: c._count._all })),
    totalEnrollments,
    aiCallsUsedTotal: aiUsage._sum.aiCallsUsed ?? 0,
    tenantsByPlan: tenantsByPlan.map((p) => ({ plan: p.plan, count: p._count._all })),
    newTenantsByDay,
  };
}
