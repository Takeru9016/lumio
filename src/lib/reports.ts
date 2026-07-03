import { db } from "@/lib/db";

export interface CompletionReportFilters {
  teamId?: string;
  courseId?: string;
  from?: Date;
  to?: Date;
}

export type CompletionStatus = "Completed" | "In Progress" | "Not Started";

export interface CompletionReportRow {
  userId: string;
  memberName: string;
  courseId: string;
  courseTitle: string;
  percentComplete: number;
  lastActive: Date | null;
  status: CompletionStatus;
}

export async function getCompletionReport(
  tenantId: string,
  filters: CompletionReportFilters
): Promise<CompletionReportRow[]> {
  const { teamId, courseId, from, to } = filters;

  const teamUserIds = teamId
    ? (await db.teamMember.findMany({ where: { teamId }, select: { userId: true } })).map(
        (m) => m.userId
      )
    : null;

  if (teamUserIds !== null && teamUserIds.length === 0) return [];

  const enrollments = await db.enrollment.findMany({
    where: {
      user: {
        tenantId,
        deletedAt: null,
        ...(teamUserIds ? { id: { in: teamUserIds } } : {}),
      },
      course: { tenantId },
      ...(courseId ? { courseId } : {}),
      ...(from || to
        ? {
            lastAccessed: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    select: {
      userId: true,
      courseId: true,
      status: true,
      lastAccessed: true,
      user: { select: { name: true, email: true } },
      course: {
        select: {
          title: true,
          sections: {
            select: {
              lessons: {
                where: { isPublished: true, isArchived: false },
                select: { id: true },
              },
            },
          },
        },
      },
    },
    orderBy: { lastAccessed: "desc" },
  });

  if (enrollments.length === 0) return [];

  const lessonIdsByCourse = new Map<string, string[]>();
  for (const e of enrollments) {
    if (!lessonIdsByCourse.has(e.courseId)) {
      lessonIdsByCourse.set(
        e.courseId,
        e.course.sections.flatMap((s) => s.lessons.map((l) => l.id))
      );
    }
  }

  const allLessonIds = Array.from(new Set(Array.from(lessonIdsByCourse.values()).flat()));
  const userIds = Array.from(new Set(enrollments.map((e) => e.userId)));

  const progress =
    allLessonIds.length > 0 && userIds.length > 0
      ? await db.lessonProgress.findMany({
          where: { userId: { in: userIds }, lessonId: { in: allLessonIds }, isCompleted: true },
          select: { userId: true, lessonId: true },
        })
      : [];

  const completedSet = new Set(progress.map((p) => `${p.userId}:${p.lessonId}`));

  return enrollments
    .map((e): CompletionReportRow => {
      const lessonIds = lessonIdsByCourse.get(e.courseId) ?? [];
      const completedCount = lessonIds.filter((lid) =>
        completedSet.has(`${e.userId}:${lid}`)
      ).length;
      const percentComplete =
        e.status === "COMPLETED"
          ? 100
          : lessonIds.length > 0
            ? Math.round((completedCount / lessonIds.length) * 100)
            : 0;
      const status: CompletionStatus =
        e.status === "COMPLETED" ? "Completed" : completedCount > 0 ? "In Progress" : "Not Started";

      return {
        userId: e.userId,
        memberName: e.user.name ?? e.user.email,
        courseId: e.courseId,
        courseTitle: e.course.title,
        percentComplete,
        lastActive: e.lastAccessed,
        status,
      };
    })
    .sort((a, b) => a.memberName.localeCompare(b.memberName));
}
