import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { CourseEditor } from "@/components/course/CourseEditor";
import type { SectionItem } from "@/components/course/LessonList";

interface EditCoursePageProps {
  params: Promise<{ courseId: string }>;
}

export default async function EditCoursePage({ params }: EditCoursePageProps) {
  const { courseId } = await params;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!user) redirect("/sign-in");

  const course = await db.course.findUnique({
    where: { id: courseId, instructorId: user.id },
    include: {
      sections: {
        orderBy: { order: "asc" },
        include: {
          lessons: {
            orderBy: { order: "asc" },
            select: {
              id: true,
              title: true,
              type: true,
              order: true,
              isPublished: true,
              videoStatus: true,
              videoDuration: true,
              muxPlaybackId: true,
              textContent: true,
            },
          },
        },
      },
    },
  });

  if (!course) notFound();

  const sections: SectionItem[] = course.sections.map((s) => ({
    id: s.id,
    title: s.title,
    order: s.order,
    lessons: s.lessons.map((l) => ({
      id: l.id,
      title: l.title,
      type: l.type,
      order: l.order,
      isPublished: l.isPublished,
      videoStatus: l.videoStatus,
      videoDuration: l.videoDuration,
    })),
  }));

  return (
    <div className="flex flex-col h-full">
      <CourseEditor
        courseId={course.id}
        initialSections={sections}
        courseTitle={course.title}
        courseStatus={course.status}
      />
    </div>
  );
}
