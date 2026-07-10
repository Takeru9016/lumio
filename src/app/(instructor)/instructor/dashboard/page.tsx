import { auth } from "@clerk/nextjs/server";
import { BookOpen, ClipboardList, GraduationCap, TrendingUp, Users } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EnrollmentChart, StatCard } from "@/components";
import { db } from "@/lib/db";
import { getInstructorDashboardData } from "@/lib/instructor-dashboard";

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-surface-3 text-text-muted",
  PUBLISHED: "bg-success-bg text-success",
  ARCHIVED: "bg-surface-3 text-text-disabled",
};

export default async function InstructorDashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  const data = await getInstructorDashboardData(dbUser.id);

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <h1
          className="text-xl font-semibold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Dashboard
        </h1>
        <p className="text-sm text-text-muted">An overview across all your courses.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Published courses" value={data.publishedCourseCount} icon={BookOpen} />
        <StatCard label="Total students" value={data.totalStudents} icon={Users} />
        <StatCard label="Total courses" value={data.courses.length} icon={GraduationCap} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="Completion rate" value={`${data.completionRate}%`} icon={TrendingUp} />
        <Link
          href="/instructor/students"
          className="rounded-lg border border-border bg-white p-4 shadow-sm transition-colors hover:bg-surface-2"
        >
          <div className="flex items-center gap-2 text-text-muted">
            <ClipboardList size={15} />
            <span className="text-xs font-medium">Pending grading</span>
          </div>
          <p
            className="mt-2 text-2xl font-bold text-text-primary"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {data.pendingGradingCount}
          </p>
        </Link>
      </div>

      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-text-primary">Enrollments (30 days)</h2>
        <div className="mt-4">
          <EnrollmentChart data={data.enrollmentsByDay} />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-white shadow-sm">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Your courses</h2>
        </div>
        {data.courses.length === 0 ? (
          <p className="px-5 py-6 text-sm text-text-muted">You haven't created a course yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.courses.map((course) => (
              <li key={course.id}>
                <Link
                  href={`/courses/${course.slug}/analytics`}
                  className="flex items-center justify-between gap-4 px-5 py-3 transition-colors hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{course.title}</p>
                    <p className="text-xs text-text-muted">{course.enrollmentCount} enrolled</p>
                  </div>
                  <span
                    className={`flex-none rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      STATUS_BADGE[course.status] ?? "bg-surface-3 text-text-muted"
                    }`}
                  >
                    {course.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
