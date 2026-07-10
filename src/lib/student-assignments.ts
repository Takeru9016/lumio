import { db } from "@/lib/db";

export type StudentAssignmentStatus = "NOT_SUBMITTED" | "OVERDUE" | "SUBMITTED" | "LATE" | "GRADED";

export interface StudentAssignmentItem {
  courseSlug: string;
  courseTitle: string;
  lessonSlug: string;
  assignmentId: string;
  title: string;
  dueDate: Date | null;
  maxScore: number;
  status: StudentAssignmentStatus;
  score: number | null;
}

export async function getStudentAssignments(userId: string): Promise<StudentAssignmentItem[]> {
  const now = new Date();

  const lessons = await db.lesson.findMany({
    where: {
      type: "ASSIGNMENT",
      isPublished: true,
      isArchived: false,
      assignment: { isNot: null },
      section: {
        course: {
          enrollments: { some: { userId, status: { in: ["ACTIVE", "COMPLETED"] } } },
        },
      },
    },
    select: {
      id: true,
      slug: true,
      section: { select: { course: { select: { slug: true, title: true } } } },
      assignment: {
        select: {
          id: true,
          title: true,
          dueDate: true,
          maxScore: true,
          submissions: {
            where: { userId },
            select: { status: true, score: true },
          },
        },
      },
    },
  });

  const items: StudentAssignmentItem[] = lessons
    .filter((lesson) => lesson.assignment)
    .map((lesson) => {
      const assignment = lesson.assignment!;
      const submission = assignment.submissions[0] ?? null;

      let status: StudentAssignmentStatus;
      if (!submission) {
        status = assignment.dueDate && assignment.dueDate < now ? "OVERDUE" : "NOT_SUBMITTED";
      } else {
        status = submission.status;
      }

      return {
        courseSlug: lesson.section.course.slug,
        courseTitle: lesson.section.course.title,
        lessonSlug: lesson.slug,
        assignmentId: assignment.id,
        title: assignment.title,
        dueDate: assignment.dueDate,
        maxScore: assignment.maxScore,
        status,
        score: submission?.score ?? null,
      };
    });

  const statusRank: Record<StudentAssignmentStatus, number> = {
    OVERDUE: 0,
    NOT_SUBMITTED: 1,
    LATE: 2,
    SUBMITTED: 3,
    GRADED: 4,
  };

  return items.sort((a, b) => {
    const rankDiff = statusRank[a.status] - statusRank[b.status];
    if (rankDiff !== 0) return rankDiff;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.getTime() - b.dueDate.getTime();
  });
}
