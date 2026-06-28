import { redirect, notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib";

import { CoursePlayerClient } from "./_components/CoursePlayerClient";
import type { SidebarSection } from "./_components/LessonSidebar";

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
              where: { isPublished: true },
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
      },
    }),
  ]);

  if (!course || course.status === "DRAFT") notFound();
  // Archived courses: only enrolled students may continue their lessons
  if (course.status === "ARCHIVED" && !enrollment) notFound();
  if (!lesson || !lesson.isPublished) notFound();
  if (!enrollment) redirect(`/courses/${courseId}`);

  const allPublishedLessons = course.sections.flatMap((s) => s.lessons);
  const lessonIndex = allPublishedLessons.findIndex((l) => l.id === lessonId);

  const completedRecords = await db.lessonProgress.findMany({
    where: {
      userId: dbUser.id,
      isCompleted: true,
      lessonId: { in: allPublishedLessons.map((l) => l.id) },
    },
    select: { lessonId: true },
  });
  const completedIds = completedRecords.map((r) => r.lessonId);

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

  return (
    <CoursePlayerClient
      courseId={courseId}
      courseTitle={course.title}
      lesson={lesson}
      lessonIndex={lessonIndex + 1}
      totalLessons={allPublishedLessons.length}
      sections={sections}
      initialCompletedIds={completedIds}
    />
  );
}
