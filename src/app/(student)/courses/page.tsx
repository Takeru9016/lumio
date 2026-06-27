import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { CourseCard } from "@/components/course/CourseCard";
import { EmptyState } from "@/components/shared/EmptyState";

type Tab = "all" | "in-progress" | "completed";

export default async function CoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const { tab: rawTab = "all" } = await searchParams;
  const tab: Tab =
    rawTab === "in-progress" || rawTab === "completed" ? rawTab : "all";

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, tenantId: true },
  });
  if (!dbUser) redirect("/sign-in");

  const [enrollments, availableCourses] = await Promise.all([
    db.enrollment.findMany({
      where: { userId: dbUser.id },
      select: {
        id: true,
        status: true,
        courseId: true,
        course: {
          select: {
            id: true,
            title: true,
            thumbnailUrl: true,
            category: true,
            price: true,
            currency: true,
            instructor: { select: { name: true } },
            sections: {
              select: {
                lessons: {
                  select: {
                    id: true,
                    aiSummary: true,
                    quiz: { select: { isAiGenerated: true } },
                    progress: {
                      where: { userId: dbUser.id },
                      select: { isCompleted: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    tab === "all"
      ? db.course.findMany({
          where: {
            status: "PUBLISHED",
            ...(dbUser.tenantId ? { tenantId: dbUser.tenantId } : {}),
            enrollments: { none: { userId: dbUser.id } },
          },
          select: {
            id: true,
            title: true,
            thumbnailUrl: true,
            category: true,
            price: true,
            currency: true,
            instructor: { select: { name: true } },
            sections: {
              select: {
                lessons: {
                  select: {
                    aiSummary: true,
                    quiz: { select: { isAiGenerated: true } },
                  },
                },
              },
            },
          },
          orderBy: { publishedAt: "desc" },
          take: 24,
        })
      : Promise.resolve([]),
  ]);

  const enrolledCards = enrollments
    .filter((e) => {
      if (tab === "in-progress") return e.status === "ACTIVE";
      if (tab === "completed") return e.status === "COMPLETED";
      return true;
    })
    .map((e) => {
      const allLessons = e.course.sections.flatMap((s) => s.lessons);
      const totalLessons = allLessons.length;
      const completedLessons = allLessons.filter(
        (l) => l.progress[0]?.isCompleted,
      ).length;
      const hasAiContent = allLessons.some(
        (l) => l.aiSummary !== null || l.quiz?.isAiGenerated === true,
      );
      return {
        course: {
          id: e.course.id,
          title: e.course.title,
          thumbnailUrl: e.course.thumbnailUrl,
          instructor: e.course.instructor,
          category: e.course.category,
          price: e.course.price,
          currency: e.course.currency,
          hasAiContent,
        },
        enrollment: {
          status: e.status as "ACTIVE" | "COMPLETED" | "REFUNDED",
          completedLessons,
          totalLessons,
        },
      };
    });

  const availableCards = availableCourses.map((c) => {
    const allLessons = c.sections.flatMap((s) => s.lessons);
    const hasAiContent = allLessons.some(
      (l) => l.aiSummary !== null || l.quiz?.isAiGenerated === true,
    );
    return {
      course: {
        id: c.id,
        title: c.title,
        thumbnailUrl: c.thumbnailUrl,
        instructor: c.instructor,
        category: c.category,
        price: c.price,
        currency: c.currency,
        hasAiContent,
      },
    };
  });

  const tabs: { id: Tab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in-progress", label: "In Progress" },
    { id: "completed", label: "Completed" },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-(--color-text-primary)">Courses</h1>
        <p className="text-sm text-(--color-text-muted) mt-1">
          Browse your enrolled courses and discover new ones.
        </p>
      </div>

      <div className="flex gap-1 border-b border-(--color-border)">
        {tabs.map(({ id, label }) => (
          <Link
            key={id}
            href={`/courses?tab=${id}`}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? "border-(--color-brand) text-(--color-brand)"
                : "border-transparent text-(--color-text-muted) hover:text-(--color-text-secondary)"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {enrolledCards.length === 0 && availableCards.length === 0 ? (
        <EmptyState
          icon="📚"
          title="No courses yet"
          description="Explore available courses and start learning today."
          ctaLabel="Browse Courses"
          ctaHref="/courses?tab=all"
        />
      ) : (
        <div className="space-y-8">
          {enrolledCards.length > 0 && (
            <section>
              {tab === "all" && (
                <h2 className="text-base font-semibold text-(--color-text-primary) mb-4">
                  My Learning
                </h2>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {enrolledCards.map(({ course, enrollment }) => (
                  <CourseCard
                    key={course.id}
                    course={course}
                    enrollment={enrollment}
                  />
                ))}
              </div>
            </section>
          )}

          {tab === "all" && availableCards.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-(--color-text-primary) mb-4">
                Available Courses
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {availableCards.map(({ course }) => (
                  <CourseCard key={course.id} course={course} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
