import { auth } from "@clerk/nextjs/server";
import type { UIMessage } from "ai";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib";

import { CoursePlayerClient } from "./_components/CoursePlayerClient";
import type { SidebarSection } from "./_components/LessonSidebar";
import type { StudentAssignmentData } from "./_components/StudentAssignment";
import type { AttemptSummary } from "./_components/StudentQuiz";

export default async function LessonPage({
  params,
}: {
  params: Promise<{ courseId: string; lessonId: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const { courseId, lessonId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  const [enrollment, course, lesson] = await Promise.all([
    db.enrollment.findUnique({
      where: { userId_courseId: { userId: dbUser.id, courseId } },
      select: { id: true },
    }),
    db.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        title: true,
        status: true,
        sections: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            title: true,
            lessons: {
              where: { isPublished: true, isArchived: false },
              orderBy: { order: "asc" },
              select: {
                id: true,
                title: true,
                type: true,
                quiz: { select: { isAiGenerated: true } },
              },
            },
          },
        },
      },
    }),
    db.lesson.findFirst({
      where: { id: lessonId, section: { courseId } },
      select: {
        id: true,
        title: true,
        type: true,
        muxPlaybackId: true,
        videoStatus: true,
        textContent: true,
        isPublished: true,
        isArchived: true,
        quiz: {
          select: {
            id: true,
            title: true,
            passingScore: true,
            isAiGenerated: true,
            questions: {
              orderBy: { order: "asc" },
              select: {
                id: true,
                question: true,
                type: true,
                options: true,
                order: true,
              },
            },
          },
        },
        assignment: {
          select: {
            id: true,
            title: true,
            description: true,
            dueDate: true,
            maxScore: true,
            submissions: {
              where: { userId: dbUser.id },
              select: {
                id: true,
                status: true,
                textContent: true,
                fileUrl: true,
                score: true,
                feedback: true,
                submittedAt: true,
                gradedAt: true,
              },
              take: 1,
            },
          },
        },
      },
    }),
  ]);

  if (!course || course.status === "DRAFT") notFound();
  // Archived courses: only enrolled students may continue their lessons
  if (course.status === "ARCHIVED" && !enrollment) notFound();
  if (!lesson || !lesson.isPublished || lesson.isArchived) notFound();
  if (!enrollment) redirect(`/courses/${courseId}`);

  const allPublishedLessons = course.sections.flatMap((s) => s.lessons);
  const lessonIndex = allPublishedLessons.findIndex((l) => l.id === lessonId);

  let initialAttempts: AttemptSummary[] = [];
  if (lesson.type === "QUIZ" && lesson.quiz) {
    const attempts = await db.quizAttempt.findMany({
      where: { userId: dbUser.id, quizId: lesson.quiz.id },
      orderBy: { completedAt: "desc" },
      select: { id: true, score: true, isPassed: true, completedAt: true },
    });
    initialAttempts = attempts.map((a) => ({
      id: a.id,
      score: a.score,
      isPassed: a.isPassed,
      completedAt: a.completedAt.toISOString(),
    }));
  }

  const completedRecords = await db.lessonProgress.findMany({
    where: {
      userId: dbUser.id,
      isCompleted: true,
      lessonId: { in: allPublishedLessons.map((l) => l.id) },
    },
    select: { lessonId: true },
  });
  const completedIds = completedRecords.map((r) => r.lessonId);

  // Existing AI tutor conversation for this lesson (hydrates the chat on load).
  const aiChat = await db.aIChat.findFirst({
    where: { userId: dbUser.id, lessonId },
    select: { id: true, messages: true },
    orderBy: { updatedAt: "desc" },
  });
  const tutorInitialMessages = (aiChat?.messages as UIMessage[] | null) ?? [];

  const sections: SidebarSection[] = course.sections
    .map((s) => ({
      id: s.id,
      title: s.title,
      lessons: s.lessons.map((l) => ({
        id: l.id,
        title: l.title,
        type: l.type,
        isAiQuiz: l.quiz?.isAiGenerated === true,
      })),
    }))
    .filter((s) => s.lessons.length > 0);

  const quizData = lesson.quiz
    ? {
        id: lesson.quiz.id,
        title: lesson.quiz.title,
        passingScore: lesson.quiz.passingScore,
        isAiGenerated: lesson.quiz.isAiGenerated,
        questions: lesson.quiz.questions.map((q) => ({
          id: q.id,
          question: q.question,
          type: q.type,
          options: q.options as { id: string; text: string }[] | null,
          order: q.order,
        })),
      }
    : null;

  const assignmentData: StudentAssignmentData | null = lesson.assignment
    ? {
        id: lesson.assignment.id,
        title: lesson.assignment.title,
        description: lesson.assignment.description,
        dueDate: lesson.assignment.dueDate?.toISOString() ?? null,
        maxScore: lesson.assignment.maxScore,
        submission: lesson.assignment.submissions[0]
          ? {
              id: lesson.assignment.submissions[0].id,
              status: lesson.assignment.submissions[0].status,
              textContent: lesson.assignment.submissions[0].textContent,
              fileUrl: lesson.assignment.submissions[0].fileUrl,
              score: lesson.assignment.submissions[0].score,
              feedback: lesson.assignment.submissions[0].feedback,
              submittedAt: lesson.assignment.submissions[0].submittedAt.toISOString(),
              gradedAt: lesson.assignment.submissions[0].gradedAt?.toISOString() ?? null,
            }
          : null,
      }
    : null;

  return (
    <CoursePlayerClient
      courseId={courseId}
      courseTitle={course.title}
      lesson={{
        id: lesson.id,
        title: lesson.title,
        type: lesson.type,
        muxPlaybackId: lesson.muxPlaybackId,
        videoStatus: lesson.videoStatus,
        textContent: lesson.textContent,
        quiz: quizData,
        assignment: assignmentData,
      }}
      lessonIndex={lessonIndex + 1}
      totalLessons={allPublishedLessons.length}
      sections={sections}
      initialCompletedIds={completedIds}
      initialAttempts={initialAttempts}
      tutorChatId={aiChat?.id}
      tutorInitialMessages={tutorInitialMessages}
    />
  );
}
