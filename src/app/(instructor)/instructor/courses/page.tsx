import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Plus, Pencil } from "lucide-react";
import { db } from "@/lib/db";
import { EmptyState } from "@/components/shared/EmptyState";
import type { CourseStatus } from "@/generated/prisma/enums";

const STATUS_BADGE: Record<CourseStatus, { label: string; className: string }> = {
  DRAFT: {
    label: "Draft",
    className: "bg-(--color-surface-3) text-(--color-text-muted)",
  },
  PUBLISHED: {
    label: "Published",
    className: "bg-(--color-success-bg) text-(--color-success)",
  },
  ARCHIVED: {
    label: "Archived",
    className: "bg-amber-50 text-amber-600",
  },
};

export default async function InstructorCoursesPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  const courses = await db.course.findMany({
    where: { instructorId: dbUser.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      thumbnailUrl: true,
      status: true,
      category: true,
      _count: { select: { enrollments: true } },
      sections: {
        select: {
          _count: { select: { lessons: true } },
        },
      },
    },
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-(--color-text-primary)">My Courses</h1>
          <p className="text-sm text-(--color-text-muted) mt-1">
            Manage and publish your courses.
          </p>
        </div>
        <Link
          href="/courses/new"
          className="flex items-center gap-2 bg-(--color-brand) text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-(--color-brand-dark) transition-colors"
        >
          <Plus size={15} />
          New Course
        </Link>
      </div>

      {courses.length === 0 ? (
        <EmptyState
          icon="📚"
          title="No courses yet"
          description="Create your first course and start teaching."
          ctaLabel="Create Course"
          ctaHref="/courses/new"
        />
      ) : (
        <div className="space-y-3">
          {courses.map((course) => {
            const badge = STATUS_BADGE[course.status];
            const lessonCount = course.sections.reduce(
              (acc, s) => acc + s._count.lessons,
              0,
            );
            return (
              <div
                key={course.id}
                className="flex items-center gap-4 bg-(--color-surface-1) border border-(--color-border) rounded-xl p-4 hover:border-(--color-brand-light) transition-colors"
              >
                <div className="relative w-20 h-12 shrink-0 rounded-lg overflow-hidden bg-(--color-surface-3)">
                  {course.thumbnailUrl ? (
                    <Image
                      src={course.thumbnailUrl}
                      alt={course.title}
                      fill
                      className="object-cover"
                      sizes="80px"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xl">
                      📚
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <h2 className="text-sm font-semibold text-(--color-text-primary) truncate">
                      {course.title}
                    </h2>
                    <span
                      className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <p className="text-xs text-(--color-text-muted)">
                    {course.sections.length} section
                    {course.sections.length !== 1 ? "s" : ""} · {lessonCount} lesson
                    {lessonCount !== 1 ? "s" : ""} · {course._count.enrollments} enrolled
                  </p>
                </div>

                <Link
                  href={`/courses/${course.id}/edit`}
                  className="shrink-0 flex items-center gap-1.5 text-sm font-medium text-(--color-brand) hover:text-(--color-brand-dark) transition-colors"
                >
                  <Pencil size={13} />
                  Edit
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
