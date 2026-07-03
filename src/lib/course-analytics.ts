import { db } from "@/lib/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EnrollmentByDay {
  date: string;
  count: number;
}

export interface LessonDropoff {
  lessonId: string;
  title: string;
  completedCount: number;
  totalEnrolled: number;
}

export interface TopStudent {
  userId: string;
  name: string | null;
  progress: number;
  lastActive: Date | null;
}

export interface CourseAnalytics {
  totalEnrollments: number;
  completionRate: number;
  avgQuizScore: number;
  enrollmentsByDay: EnrollmentByDay[];
  lessonDropoff: LessonDropoff[];
  topStudents: TopStudent[];
}

export async function getCourseAnalytics(courseId: string): Promise<CourseAnalytics> {
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);

  const [enrollments, quizAvg, lessons, recentEnrollments] = await Promise.all([
    db.enrollment.findMany({
      where: { courseId, status: { in: ["ACTIVE", "COMPLETED"] } },
      select: {
        userId: true,
        status: true,
        lastAccessed: true,
        user: { select: { name: true } },
      },
    }),
    db.quizAttempt.aggregate({
      where: { quiz: { lesson: { section: { courseId } } } },
      _avg: { score: true },
    }),
    db.lesson.findMany({
      where: { section: { courseId }, isPublished: true, isArchived: false },
      orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
      select: { id: true, title: true },
    }),
    db.enrollment.findMany({
      where: { courseId, createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
    }),
  ]);

  const totalEnrollments = enrollments.length;
  const completedCount = enrollments.filter((e) => e.status === "COMPLETED").length;
  const completionRate =
    totalEnrollments > 0 ? Math.round((completedCount / totalEnrollments) * 100) : 0;
  const avgQuizScore = Math.round(quizAvg._avg.score ?? 0);

  const countByDate = new Map<string, number>();
  for (const e of recentEnrollments) {
    const key = e.createdAt.toISOString().slice(0, 10);
    countByDate.set(key, (countByDate.get(key) ?? 0) + 1);
  }
  const enrollmentsByDay: EnrollmentByDay[] = Array.from({ length: 30 }, (_, i) => {
    const key = new Date(Date.now() - (29 - i) * DAY_MS).toISOString().slice(0, 10);
    return { date: key, count: countByDate.get(key) ?? 0 };
  });

  const enrolledUserIds = enrollments.map((e) => e.userId);
  const lessonIds = lessons.map((l) => l.id);

  const [lessonCompletion, userCompletion] = await Promise.all([
    lessonIds.length > 0
      ? db.lessonProgress.groupBy({
          by: ["lessonId"],
          where: {
            lessonId: { in: lessonIds },
            isCompleted: true,
            userId: { in: enrolledUserIds },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    enrolledUserIds.length > 0
      ? db.lessonProgress.groupBy({
          by: ["userId"],
          where: {
            userId: { in: enrolledUserIds },
            isCompleted: true,
            lesson: { section: { courseId }, isPublished: true, isArchived: false },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const completedByLesson = new Map(lessonCompletion.map((c) => [c.lessonId, c._count._all]));
  const completedByUser = new Map(userCompletion.map((c) => [c.userId, c._count._all]));

  const lessonDropoff: LessonDropoff[] = lessons.map((l) => ({
    lessonId: l.id,
    title: l.title,
    completedCount: completedByLesson.get(l.id) ?? 0,
    totalEnrolled: totalEnrollments,
  }));

  const topStudents: TopStudent[] = enrollments
    .map((e) => ({
      userId: e.userId,
      name: e.user.name,
      progress:
        lessons.length > 0
          ? Math.round(((completedByUser.get(e.userId) ?? 0) / lessons.length) * 100)
          : 0,
      lastActive: e.lastAccessed,
    }))
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 10);

  return {
    totalEnrollments,
    completionRate,
    avgQuizScore,
    enrollmentsByDay,
    lessonDropoff,
    topStudents,
  };
}
