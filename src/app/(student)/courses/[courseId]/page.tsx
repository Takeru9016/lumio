import { auth } from "@clerk/nextjs/server";
import { BookOpen, ClipboardList, FileText, Lock, PlayCircle } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AiBadge } from "@/components";
import { db } from "@/lib/db";
import { EnrollButton } from "./_components/EnrollButton";

const LESSON_ICONS = {
  VIDEO: PlayCircle,
  TEXT: FileText,
  QUIZ: ClipboardList,
  ASSIGNMENT: BookOpen,
} as const;

export default async function CourseDetailPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const { courseId } = await params;

  const [dbUser, course] = await Promise.all([
    db.user.findUnique({
      where: { clerkId: userId },
      select: { id: true, email: true, name: true },
    }),
    db.course.findUnique({
      where: { slug: courseId },
      select: {
        id: true,
        title: true,
        description: true,
        thumbnailUrl: true,
        price: true,
        currency: true,
        category: true,
        level: true,
        status: true,
        publishedAt: true,
        instructor: { select: { id: true, name: true, avatarUrl: true } },
        sections: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            title: true,
            order: true,
            lessons: {
              where: { isArchived: false },
              orderBy: { order: "asc" },
              select: {
                id: true,
                slug: true,
                title: true,
                type: true,
                isFree: true,
                isPublished: true,
                videoDuration: true,
                aiSummary: true,
                quiz: { select: { isAiGenerated: true } },
              },
            },
          },
        },
        _count: { select: { enrollments: true } },
      },
    }),
  ]);

  if (!dbUser) redirect("/sign-in");
  if (!course || course.status === "DRAFT") notFound();

  const enrollment = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: dbUser.id, courseId: course.id } },
    select: {
      id: true,
      status: true,
    },
  });

  const isEnrolled = !!enrollment;

  // Archived courses are invisible to students who aren't enrolled
  if (course.status === "ARCHIVED" && !isEnrolled) notFound();

  const publishedLessons = course.sections.flatMap((s) => s.lessons.filter((l) => l.isPublished));

  let completedCount = 0;
  let resumeLessonId: string | null = null;
  if (isEnrolled && publishedLessons.length > 0) {
    const completedProgress = await db.lessonProgress.findMany({
      where: {
        userId: dbUser.id,
        lessonId: { in: publishedLessons.map((l) => l.id) },
        isCompleted: true,
      },
      select: { lessonId: true },
    });
    completedCount = completedProgress.length;
    const completedSet = new Set(completedProgress.map((p) => p.lessonId));
    const firstUncompleted = publishedLessons.find((l) => !completedSet.has(l.id));
    resumeLessonId =
      firstUncompleted?.slug ?? publishedLessons[publishedLessons.length - 1]?.slug ?? null;
  }

  const totalLessons = publishedLessons.length;
  const progress =
    isEnrolled && totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;

  const hasAiContent = course.sections.some((s) =>
    s.lessons.some((l) => l.aiSummary !== null || l.quiz?.isAiGenerated === true)
  );

  function formatDuration(secs: number | null) {
    if (!secs) return null;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <div className="min-h-full bg-surface-2">
      {/* Header */}
      <div className="bg-surface-1 border-b border-border">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col md:flex-row gap-8">
          {/* Thumbnail */}
          <div className="relative w-full md:w-80 shrink-0 aspect-video rounded-xl overflow-hidden bg-surface-3">
            {course.thumbnailUrl ? (
              <Image
                src={course.thumbnailUrl}
                alt={course.title}
                fill
                className="object-cover"
                sizes="320px"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-5xl">📚</div>
            )}
          </div>

          {/* Meta */}
          <div className="flex-1 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {course.category && (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-brand-light text-brand">
                  {course.category}
                </span>
              )}
              {course.level && (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface-3 text-text-muted">
                  {course.level}
                </span>
              )}
              {hasAiContent && <AiBadge label="AI-Enhanced" size="md" />}
            </div>

            <h1 className="text-2xl font-bold text-text-primary leading-tight">{course.title}</h1>

            {course.description && (
              <p className="text-sm text-text-secondary leading-relaxed line-clamp-3">
                {course.description}
              </p>
            )}

            <p className="text-sm text-text-muted">
              By{" "}
              <span className="font-medium text-text-secondary">
                {course.instructor.name ?? "Instructor"}
              </span>
            </p>

            <div className="flex items-center gap-4 text-xs text-text-muted">
              <span>{totalLessons} lessons</span>
              <span>{course.sections.length} sections</span>
              <span>{course._count.enrollments} students</span>
            </div>

            <div className="mt-auto pt-2 space-y-3">
              {isEnrolled && (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-text-muted">Your progress</span>
                    <span className="font-semibold text-text-primary">{progress}%</span>
                  </div>
                  <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </>
              )}
              <EnrollButton
                courseId={courseId}
                price={course.price}
                currency={course.currency}
                courseTitle={course.title}
                userEmail={dbUser.email}
                userName={dbUser.name}
                isEnrolled={isEnrolled}
                firstLessonId={resumeLessonId}
                progress={progress}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Curriculum */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h2 className="text-lg font-bold text-text-primary mb-4">Course Curriculum</h2>

        <div className="space-y-3">
          {course.sections.map((section) => {
            const published = section.lessons.filter((l) => l.isPublished);
            return (
              <div
                key={section.id}
                className="bg-surface-1 border border-border rounded-xl overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-3 bg-surface-2 border-b border-border">
                  <span className="font-semibold text-sm text-text-primary">{section.title}</span>
                  <span className="text-xs text-text-muted">
                    {published.length} lesson{published.length !== 1 ? "s" : ""}
                  </span>
                </div>

                <ul className="divide-y divide-border">
                  {published.map((lesson) => {
                    const Icon = LESSON_ICONS[lesson.type] ?? PlayCircle;
                    const isAccessible = isEnrolled || lesson.isFree;
                    const hasAi = lesson.aiSummary !== null || lesson.quiz?.isAiGenerated === true;

                    return (
                      <li key={lesson.id}>
                        {isAccessible ? (
                          <Link
                            href={`/courses/${courseId}/lessons/${lesson.slug}`}
                            className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors"
                          >
                            <Icon size={16} className="shrink-0 text-text-muted" />
                            <span className="flex-1 text-sm text-text-secondary">
                              {lesson.title}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              {hasAi && <AiBadge size="sm" />}
                              {lesson.isFree && !isEnrolled && (
                                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-success-bg text-success">
                                  Preview
                                </span>
                              )}
                              {lesson.videoDuration && (
                                <span className="text-xs text-text-disabled">
                                  {formatDuration(lesson.videoDuration)}
                                </span>
                              )}
                            </div>
                          </Link>
                        ) : (
                          <div className="flex items-center gap-3 px-4 py-3 opacity-60">
                            <Lock size={16} className="shrink-0 text-text-muted" />
                            <span className="flex-1 text-sm text-text-muted">{lesson.title}</span>
                            {lesson.videoDuration && (
                              <span className="text-xs text-text-disabled shrink-0">
                                {formatDuration(lesson.videoDuration)}
                              </span>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
