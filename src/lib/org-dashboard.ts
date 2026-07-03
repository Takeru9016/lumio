import { db } from "@/lib/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface OverdueTraining {
  id: string;
  courseTitle: string;
  teamName: string;
  dueDate: Date;
  remainingCount: number;
  totalMembers: number;
}

export interface OrgDashboardData {
  tenant: {
    name: string;
    plan: string;
    seatCount: number;
    seatLimit: number;
  };
  activeMembers: number;
  completionRate: number;
  certsIssuedLast30Days: number;
  overdueTrainings: OverdueTraining[];
}

export async function getOrgDashboardData(tenantId: string): Promise<OrgDashboardData> {
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);

  const [tenant, activeMembers, enrollments, certsIssuedLast30Days, trainings] = await Promise.all([
    db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, plan: true, seatCount: true, seatLimit: true },
    }),
    db.user.count({ where: { tenantId, deletedAt: null } }),
    db.enrollment.findMany({
      where: { user: { tenantId, deletedAt: null }, course: { tenantId } },
      select: { status: true },
    }),
    db.certificate.count({
      where: { user: { tenantId, deletedAt: null }, issuedAt: { gte: thirtyDaysAgo } },
    }),
    db.mandatoryTraining.findMany({
      where: { tenantId, dueDate: { lt: new Date() } },
      select: {
        id: true,
        dueDate: true,
        completedCount: true,
        course: { select: { title: true } },
        team: { select: { name: true, _count: { select: { members: true } } } },
      },
      orderBy: { dueDate: "asc" },
    }),
  ]);

  const totalEnrollments = enrollments.length;
  const completedEnrollments = enrollments.filter((e) => e.status === "COMPLETED").length;
  const completionRate =
    totalEnrollments > 0 ? Math.round((completedEnrollments / totalEnrollments) * 100) : 0;

  const overdueTrainings: OverdueTraining[] = trainings
    .map((t) => ({
      id: t.id,
      courseTitle: t.course.title,
      teamName: t.team.name,
      dueDate: t.dueDate,
      remainingCount: Math.max(t.team._count.members - t.completedCount, 0),
      totalMembers: t.team._count.members,
    }))
    .filter((t) => t.remainingCount > 0);

  return {
    tenant,
    activeMembers,
    completionRate,
    certsIssuedLast30Days,
    overdueTrainings,
  };
}
