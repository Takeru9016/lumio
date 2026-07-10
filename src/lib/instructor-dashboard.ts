import { db } from "@/lib/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InstructorCourseSummary {
  id: string;
  slug: string;
  title: string;
  status: string;
  enrollmentCount: number;
}

export interface InstructorDashboardData {
  courses: InstructorCourseSummary[];
  totalStudents: number;
  publishedCourseCount: number;
  enrollmentsByDay: { date: string; count: number }[];
  completionRate: number;
  pendingGradingCount: number;
}

export async function getInstructorDashboardData(
  instructorId: string
): Promise<InstructorDashboardData> {
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);

  const [courses, distinctStudents, recentEnrollments, enrollmentStatuses, pendingGradingCount] =
    await Promise.all([
      db.course.findMany({
        where: { instructorId },
        select: {
          id: true,
          slug: true,
          title: true,
          status: true,
          _count: { select: { enrollments: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.enrollment.findMany({
        where: { course: { instructorId } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      db.enrollment.findMany({
        where: { course: { instructorId }, createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
      }),
      db.enrollment.findMany({
        where: { course: { instructorId }, status: { in: ["ACTIVE", "COMPLETED"] } },
        select: { status: true },
      }),
      db.assignmentSubmission.count({
        where: {
          status: { in: ["SUBMITTED", "LATE"] },
          assignment: { lesson: { section: { course: { instructorId } } } },
        },
      }),
    ]);

  const completionRate =
    enrollmentStatuses.length > 0
      ? Math.round(
          (enrollmentStatuses.filter((e) => e.status === "COMPLETED").length /
            enrollmentStatuses.length) *
            100
        )
      : 0;

  const countByDate = new Map<string, number>();
  for (const e of recentEnrollments) {
    const key = e.createdAt.toISOString().slice(0, 10);
    countByDate.set(key, (countByDate.get(key) ?? 0) + 1);
  }
  const enrollmentsByDay = Array.from({ length: 30 }, (_, i) => {
    const key = new Date(Date.now() - (29 - i) * DAY_MS).toISOString().slice(0, 10);
    return { date: key, count: countByDate.get(key) ?? 0 };
  });

  return {
    courses: courses.map((c) => ({
      id: c.id,
      slug: c.slug,
      title: c.title,
      status: c.status,
      enrollmentCount: c._count.enrollments,
    })),
    totalStudents: distinctStudents.length,
    publishedCourseCount: courses.filter((c) => c.status === "PUBLISHED").length,
    enrollmentsByDay,
    completionRate,
    pendingGradingCount,
  };
}
