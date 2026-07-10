import { db } from "@/lib/db";

export interface InstructorStudentRow {
  userId: string;
  name: string | null;
  email: string;
  courseCount: number;
  courseTitles: string[];
  avgProgress: number;
  quizAvg: number | null;
  enrolledAt: Date;
  lastAccessed: Date | null;
}

export async function getInstructorStudents(instructorId: string): Promise<InstructorStudentRow[]> {
  const rawEnrollments = await db.enrollment.findMany({
    where: { course: { instructorId } },
    select: {
      userId: true,
      createdAt: true,
      lastAccessed: true,
      courseId: true,
      user: { select: { name: true, email: true } },
      course: {
        select: {
          title: true,
          sections: { select: { lessons: { select: { id: true } } } },
        },
      },
    },
  });

  if (rawEnrollments.length === 0) return [];

  const courseLessonIds = new Map<string, string[]>();
  for (const e of rawEnrollments) {
    if (!courseLessonIds.has(e.courseId)) {
      courseLessonIds.set(
        e.courseId,
        e.course.sections.flatMap((s) => s.lessons.map((l) => l.id))
      );
    }
  }

  const allLessonIds = [...new Set([...courseLessonIds.values()].flat())];
  const allUserIds = [...new Set(rawEnrollments.map((e) => e.userId))];

  const [completedProgress, quizAttempts] = await Promise.all([
    allLessonIds.length > 0
      ? db.lessonProgress.findMany({
          where: { userId: { in: allUserIds }, lessonId: { in: allLessonIds }, isCompleted: true },
          select: { userId: true, lessonId: true },
        })
      : Promise.resolve([]),
    db.quizAttempt.groupBy({
      by: ["userId"],
      where: {
        userId: { in: allUserIds },
        quiz: { lesson: { section: { course: { instructorId } } } },
      },
      _avg: { score: true },
    }),
  ]);

  const completedByUser = new Map<string, Set<string>>();
  for (const p of completedProgress) {
    if (!completedByUser.has(p.userId)) completedByUser.set(p.userId, new Set());
    completedByUser.get(p.userId)?.add(p.lessonId);
  }

  const quizAvgByUser = new Map(quizAttempts.map((q) => [q.userId, q._avg.score]));

  interface StudentAccumulator {
    name: string | null;
    email: string;
    courseTitles: Set<string>;
    progresses: number[];
    enrolledAt: Date;
    lastAccessed: Date | null;
  }

  const byStudent = new Map<string, StudentAccumulator>();

  for (const e of rawEnrollments) {
    const lessonIds = courseLessonIds.get(e.courseId) ?? [];
    const completed = lessonIds.filter((id) => completedByUser.get(e.userId)?.has(id)).length;
    const progress = lessonIds.length > 0 ? Math.round((completed / lessonIds.length) * 100) : 0;

    const existing = byStudent.get(e.userId);
    if (!existing) {
      byStudent.set(e.userId, {
        name: e.user.name,
        email: e.user.email,
        courseTitles: new Set([e.course.title]),
        progresses: [progress],
        enrolledAt: e.createdAt,
        lastAccessed: e.lastAccessed,
      });
    } else {
      existing.courseTitles.add(e.course.title);
      existing.progresses.push(progress);
      if (e.createdAt < existing.enrolledAt) existing.enrolledAt = e.createdAt;
      if (e.lastAccessed && (!existing.lastAccessed || e.lastAccessed > existing.lastAccessed)) {
        existing.lastAccessed = e.lastAccessed;
      }
    }
  }

  return Array.from(byStudent.entries())
    .map(([userId, s]) => {
      const quizAvg = quizAvgByUser.get(userId);
      return {
        userId,
        name: s.name,
        email: s.email,
        courseCount: s.courseTitles.size,
        courseTitles: Array.from(s.courseTitles),
        avgProgress: Math.round(s.progresses.reduce((sum, p) => sum + p, 0) / s.progresses.length),
        quizAvg: quizAvg != null ? Math.round(quizAvg) : null,
        enrolledAt: s.enrolledAt,
        lastAccessed: s.lastAccessed,
      };
    })
    .sort((a, b) => (b.lastAccessed?.getTime() ?? 0) - (a.lastAccessed?.getTime() ?? 0));
}

export interface InstructorStudentCourseDetail {
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  status: string;
  progress: number;
  enrolledAt: Date;
  lastAccessed: Date | null;
}

export interface InstructorStudentQuizAttempt {
  id: string;
  quizTitle: string;
  lessonTitle: string;
  courseTitle: string;
  score: number;
  isPassed: boolean;
  completedAt: Date;
}

export interface InstructorStudentDetail {
  userId: string;
  name: string | null;
  email: string;
  courses: InstructorStudentCourseDetail[];
  quizAttempts: InstructorStudentQuizAttempt[];
}

// Returns null when the instructor has no course this student is enrolled in —
// callers must treat that the same as "not found", not just "empty".
export async function getInstructorStudentDetail(
  instructorId: string,
  studentId: string
): Promise<InstructorStudentDetail | null> {
  const enrollments = await db.enrollment.findMany({
    where: { userId: studentId, course: { instructorId } },
    select: {
      courseId: true,
      status: true,
      createdAt: true,
      lastAccessed: true,
      user: { select: { name: true, email: true } },
      course: {
        select: {
          slug: true,
          title: true,
          sections: { select: { lessons: { select: { id: true } } } },
        },
      },
    },
  });

  if (enrollments.length === 0) return null;

  const allLessonIds = enrollments.flatMap((e) =>
    e.course.sections.flatMap((s) => s.lessons.map((l) => l.id))
  );

  const [completedProgress, rawAttempts] = await Promise.all([
    allLessonIds.length > 0
      ? db.lessonProgress.findMany({
          where: { userId: studentId, lessonId: { in: allLessonIds }, isCompleted: true },
          select: { lessonId: true },
        })
      : Promise.resolve([]),
    db.quizAttempt.findMany({
      where: {
        userId: studentId,
        quiz: { lesson: { section: { course: { instructorId } } } },
      },
      select: {
        id: true,
        score: true,
        isPassed: true,
        completedAt: true,
        quiz: {
          select: {
            title: true,
            lesson: {
              select: { title: true, section: { select: { course: { select: { title: true } } } } },
            },
          },
        },
      },
      orderBy: { completedAt: "desc" },
    }),
  ]);

  const completedSet = new Set(completedProgress.map((p) => p.lessonId));

  const courses: InstructorStudentCourseDetail[] = enrollments.map((e) => {
    const lessonIds = e.course.sections.flatMap((s) => s.lessons.map((l) => l.id));
    const completed = lessonIds.filter((id) => completedSet.has(id)).length;
    return {
      courseId: e.courseId,
      courseSlug: e.course.slug,
      courseTitle: e.course.title,
      status: e.status,
      progress: lessonIds.length > 0 ? Math.round((completed / lessonIds.length) * 100) : 0,
      enrolledAt: e.createdAt,
      lastAccessed: e.lastAccessed,
    };
  });

  const quizAttempts: InstructorStudentQuizAttempt[] = rawAttempts.map((a) => ({
    id: a.id,
    quizTitle: a.quiz.title,
    lessonTitle: a.quiz.lesson.title,
    courseTitle: a.quiz.lesson.section.course.title,
    score: a.score,
    isPassed: a.isPassed,
    completedAt: a.completedAt,
  }));

  return {
    userId: studentId,
    name: enrollments[0].user.name,
    email: enrollments[0].user.email,
    courses,
    quizAttempts,
  };
}
