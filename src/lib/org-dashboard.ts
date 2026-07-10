import { db } from "@/lib/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const AT_RISK_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OverdueTraining {
  id: string;
  courseTitle: string;
  teamName: string;
  dueDate: Date;
  remainingCount: number;
  totalMembers: number;
}

export interface TeamBreakdown {
  teamId: string;
  teamName: string;
  memberCount: number;
  completionRate: number;
}

export interface CourseBreakdown {
  courseId: string;
  courseTitle: string;
  enrollmentCount: number;
  completionRate: number;
}

export interface AtRiskMember {
  userId: string;
  name: string | null;
  email: string;
  courseTitle: string;
  daysSinceActive: number | null;
}

export interface OrgDashboardData {
  tenant: {
    name: string;
    plan: string;
    seatLimit: number;
  };
  activeMembers: number;
  completionRate: number;
  completionRateDelta: number;
  certsIssuedLast30Days: number;
  overdueTrainings: OverdueTraining[];
  teamBreakdown: TeamBreakdown[];
  courseBreakdown: CourseBreakdown[];
  atRiskMembers: AtRiskMember[];
}

export async function getOrgDashboardData(tenantId: string): Promise<OrgDashboardData> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
  const sixtyDaysAgo = new Date(now.getTime() - SIXTY_DAYS_MS);
  const staleCutoff = new Date(now.getTime() - AT_RISK_STALE_MS);

  const [tenant, activeMembers, users, enrollments, certsIssuedLast30Days, trainings, teams] =
    await Promise.all([
      db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, plan: true, seatLimit: true },
      }),
      db.user.count({ where: { tenantId, deletedAt: null } }),
      db.user.findMany({
        where: { tenantId, deletedAt: null },
        select: { id: true, name: true, email: true },
      }),
      db.enrollment.findMany({
        where: { user: { tenantId, deletedAt: null }, course: { tenantId } },
        select: {
          userId: true,
          status: true,
          lastAccessed: true,
          completedAt: true,
          courseId: true,
          course: { select: { title: true } },
        },
      }),
      db.certificate.count({
        where: { user: { tenantId, deletedAt: null }, issuedAt: { gte: thirtyDaysAgo } },
      }),
      db.mandatoryTraining.findMany({
        where: { tenantId, dueDate: { lt: now } },
        select: {
          id: true,
          dueDate: true,
          completedCount: true,
          course: { select: { title: true } },
          team: { select: { name: true, _count: { select: { members: true } } } },
        },
        orderBy: { dueDate: "asc" },
      }),
      db.team.findMany({
        where: { tenantId },
        select: { id: true, name: true, members: { select: { userId: true } } },
      }),
    ]);

  const totalEnrollments = enrollments.length;
  const completedEnrollments = enrollments.filter((e) => e.status === "COMPLETED").length;
  const completionRate =
    totalEnrollments > 0 ? Math.round((completedEnrollments / totalEnrollments) * 100) : 0;

  // Trend: completions recorded in the last 30 days vs. the 30 days before that —
  // a point-in-time completion % has no history to diff against, so this compares
  // completion *volume* between the two windows instead.
  const completionsLast30 = enrollments.filter(
    (e) => e.completedAt && e.completedAt >= thirtyDaysAgo
  ).length;
  const completionsPrev30 = enrollments.filter(
    (e) => e.completedAt && e.completedAt >= sixtyDaysAgo && e.completedAt < thirtyDaysAgo
  ).length;
  const completionRateDelta = completionsLast30 - completionsPrev30;

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

  const enrollmentsByUser = new Map<string, typeof enrollments>();
  for (const e of enrollments) {
    if (!enrollmentsByUser.has(e.userId)) enrollmentsByUser.set(e.userId, []);
    enrollmentsByUser.get(e.userId)?.push(e);
  }

  const teamBreakdown: TeamBreakdown[] = teams.map((team) => {
    const memberIds = new Set(team.members.map((m) => m.userId));
    const teamEnrollments = enrollments.filter((e) => memberIds.has(e.userId));
    const completed = teamEnrollments.filter((e) => e.status === "COMPLETED").length;
    return {
      teamId: team.id,
      teamName: team.name,
      memberCount: memberIds.size,
      completionRate:
        teamEnrollments.length > 0 ? Math.round((completed / teamEnrollments.length) * 100) : 0,
    };
  });

  const courseAgg = new Map<string, { title: string; total: number; completed: number }>();
  for (const e of enrollments) {
    const existing = courseAgg.get(e.courseId);
    if (!existing) {
      courseAgg.set(e.courseId, {
        title: e.course.title,
        total: 1,
        completed: e.status === "COMPLETED" ? 1 : 0,
      });
    } else {
      existing.total += 1;
      if (e.status === "COMPLETED") existing.completed += 1;
    }
  }
  const courseBreakdown: CourseBreakdown[] = Array.from(courseAgg.entries())
    .map(([courseId, agg]) => ({
      courseId,
      courseTitle: agg.title,
      enrollmentCount: agg.total,
      completionRate: Math.round((agg.completed / agg.total) * 100),
    }))
    .sort((a, b) => b.enrollmentCount - a.enrollmentCount);

  const atRiskMembers: AtRiskMember[] = users
    .map((user) => {
      const active = (enrollmentsByUser.get(user.id) ?? []).filter((e) => e.status === "ACTIVE");
      if (active.length === 0) return null;

      const stalest = active.reduce((oldest, e) =>
        (e.lastAccessed?.getTime() ?? 0) < (oldest.lastAccessed?.getTime() ?? 0) ? e : oldest
      );
      const isStale = !stalest.lastAccessed || stalest.lastAccessed < staleCutoff;
      if (!isStale) return null;

      return {
        userId: user.id,
        name: user.name,
        email: user.email,
        courseTitle: stalest.course.title,
        daysSinceActive: stalest.lastAccessed
          ? Math.floor((now.getTime() - stalest.lastAccessed.getTime()) / DAY_MS)
          : null,
      };
    })
    .filter((m): m is AtRiskMember => m !== null)
    .sort(
      (a, b) =>
        (b.daysSinceActive ?? Number.MAX_SAFE_INTEGER) -
        (a.daysSinceActive ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, 10);

  return {
    tenant,
    activeMembers,
    completionRate,
    completionRateDelta,
    certsIssuedLast30Days,
    overdueTrainings,
    teamBreakdown,
    courseBreakdown,
    atRiskMembers,
  };
}
