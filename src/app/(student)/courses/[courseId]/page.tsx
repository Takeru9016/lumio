import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Lock, PlayCircle, FileText, ClipboardList, BookOpen } from "lucide-react";
import { db } from "@/lib/db";
import { AiBadge } from "@/components/shared/AiBadge";
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
      where: { id: courseId },
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
              orderBy: { order: "asc" },
              select: {
                id: true,
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
    where: { userId_courseId: { userId: dbUser.id, courseId } },
    select: {
      id: true,
      status: true,
    },
  });

  const isEnrolled = !!enrollment;

  // Archived courses are invisible to students who aren't enrolled
  if (course.status === "ARCHIVED" && !isEnrolled) notFound();

  const publishedLessons = course.sections.flatMap((s) =>
    s.lessons.filter((l) => l.isPublished),
  );

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
      firstUncompleted?.id ?? publishedLessons[publishedLessons.length - 1]?.id ?? null;
  }

  const totalLessons = publishedLessons.length;
  const progress =
    isEnrolled && totalLessons > 0
      ? Math.round((completedCount / totalLessons) * 100)
      : 0;

  const hasAiContent = course.sections.some((s) =>
    s.lessons.some((l) => l.aiSummary !== null || l.quiz?.isAiGenerated === true),
  );

  function formatDuration(secs: number | null) {
    if (!secs) return null;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <div className="min-h-full bg-(--color-surface-2)">
      {/* Header */}
      <div className="bg-(--color-surface-1) border-b border-(--color-border)">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col md:flex-row gap-8">
          {/* Thumbnail */}
          <div className="relative w-full md:w-80 shrink-0 aspect-video rounded-xl overflow-hidden bg-(--color-surface-3)">
            {course.thumbnailUrl ? (
              <Image
                src={course.thumbnailUrl}
                alt={course.title}
                fill
                className="object-cover"
                sizes="320px"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-5xl">
                📚
              </div>
            )}
          </div>

          {/* Meta */}
          <div className="flex-1 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {course.category && (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-(--color-brand-light) text-(--color-brand)">
                  {course.category}
                </span>
              )}
              {course.level && (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-(--color-surface-3) text-(--color-text-muted)">
                  {course.level}
                </span>
              )}
              {hasAiContent && <AiBadge label="AI-Enhanced" size="md" />}
            </div>

            <h1 className="text-2xl font-bold text-(--color-text-primary) leading-tight">
              {course.title}
            </h1>

            {course.description && (
              <p className="text-sm text-(--color-text-secondary) leading-relaxed line-clamp-3">
                {course.description}
              </p>
            )}

            <p className="text-sm text-(--color-text-muted)">
              By{" "}
              <span className="font-medium text-(--color-text-secondary)">
                {course.instructor.name ?? "Instructor"}
              </span>
            </p>

            <div className="flex items-center gap-4 text-xs text-(--color-text-muted)">
              <span>{totalLessons} lessons</span>
              <span>{course.sections.length} sections</span>
              <span>{course._count.enrollments} students</span>
            </div>

            <div className="mt-auto pt-2">
              {isEnrolled ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-(--color-text-muted)">Your progress</span>
                    <span className="font-semibold text-(--color-text-primary)">
                      {progress}%
                    </span>
                  </div>
                  <div className="h-2 bg-(--color-surface-3) rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-(--color-brand) transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <Link
                    href={
                      resumeLessonId
                        ? `/courses/${courseId}/lessons/${resumeLessonId}`
                        : `/courses/${courseId}`
                    }
                    className="flex items-center justify-center w-full py-3 px-6 rounded-xl font-semibold text-sm bg-(--color-brand) text-white hover:bg-(--color-brand-dark) transition-colors"
                  >
                    {progress === 0 ? "Start Learning" : "Continue Learning"}
                  </Link>
                </div>
              ) : (
                <EnrollButton
                  courseId={courseId}
                  price={course.price}
                  currency={course.currency}
                  courseTitle={course.title}
                  userEmail={dbUser.email}
                  userName={dbUser.name}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Curriculum */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h2 className="text-lg font-bold text-(--color-text-primary) mb-4">
          Course Curriculum
        </h2>

        <div className="space-y-3">
          {course.sections.map((section) => {
            const published = section.lessons.filter((l) => l.isPublished);
            return (
              <div
                key={section.id}
                className="bg-(--color-surface-1) border border-(--color-border) rounded-xl overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-3 bg-(--color-surface-2) border-b border-(--color-border)">
                  <span className="font-semibold text-sm text-(--color-text-primary)">
                    {section.title}
                  </span>
                  <span className="text-xs text-(--color-text-muted)">
                    {published.length} lesson{published.length !== 1 ? "s" : ""}
                  </span>
                </div>

                <ul className="divide-y divide-(--color-border)">
                  {published.map((lesson) => {
                    const Icon = LESSON_ICONS[lesson.type] ?? PlayCircle;
                    const isAccessible = isEnrolled || lesson.isFree;
                    const hasAi =
                      lesson.aiSummary !== null ||
                      lesson.quiz?.isAiGenerated === true;

                    return (
                      <li key={lesson.id}>
                        {isAccessible ? (
                          <Link
                            href={`/courses/${courseId}/lessons/${lesson.id}`}
                            className="flex items-center gap-3 px-4 py-3 hover:bg-(--color-surface-2) transition-colors"
                          >
                            <Icon
                              size={16}
                              className="shrink-0 text-(--color-text-muted)"
                            />
                            <span className="flex-1 text-sm text-(--color-text-secondary)">
                              {lesson.title}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              {hasAi && <AiBadge size="sm" />}
                              {lesson.isFree && !isEnrolled && (
                                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-(--color-success-bg) text-(--color-success)">
                                  Preview
                                </span>
                              )}
                              {lesson.videoDuration && (
                                <span className="text-xs text-(--color-text-disabled)">
                                  {formatDuration(lesson.videoDuration)}
                                </span>
                              )}
                            </div>
                          </Link>
                        ) : (
                          <div className="flex items-center gap-3 px-4 py-3 opacity-60">
                            <Lock size={16} className="shrink-0 text-(--color-text-muted)" />
                            <span className="flex-1 text-sm text-(--color-text-muted)">
                              {lesson.title}
                            </span>
                            {lesson.videoDuration && (
                              <span className="text-xs text-(--color-text-disabled) shrink-0">
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
