import { auth } from "@clerk/nextjs/server";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { EnrollmentChart } from "@/components";
import { getCourseAnalytics } from "@/lib/course-analytics";
import { db } from "@/lib/db";

interface CourseAnalyticsPageProps {
  params: Promise<{ courseId: string }>;
}

export default async function CourseAnalyticsPage({ params }: CourseAnalyticsPageProps) {
  const { courseId } = await params;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  const course = await db.course.findUnique({
    where: { slug: courseId, instructorId: dbUser.id },
    select: { id: true, slug: true, title: true },
  });
  if (!course) notFound();

  const analytics = await getCourseAnalytics(course.id);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div>
        <Link
          href={`/courses/${course.slug}/edit`}
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          Back to editor
        </Link>
        <h1 className="text-xl font-semibold font-heading text-text-primary">Analytics</h1>
        <p className="text-sm text-text-muted mt-1">{course.title}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Total enrollments</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {analytics.totalEnrollments}
          </p>
        </div>
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Completion rate</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {analytics.completionRate}%
          </p>
        </div>
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Avg quiz score</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {analytics.avgQuizScore}%
          </p>
        </div>
      </div>

      <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
        <p className="text-sm font-semibold text-text-primary mb-3">Enrollments — last 30 days</p>
        <EnrollmentChart data={analytics.enrollmentsByDay} />
      </div>

      <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-text-primary">Lesson drop-off</p>
        </div>
        {analytics.lessonDropoff.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">No published lessons yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-border">
                <th className="px-4 py-2 font-medium">Lesson</th>
                <th className="px-4 py-2 font-medium">Completed</th>
                <th className="px-4 py-2 font-medium">% complete</th>
              </tr>
            </thead>
            <tbody>
              {analytics.lessonDropoff.map((lesson) => {
                const pct =
                  lesson.totalEnrolled > 0
                    ? Math.round((lesson.completedCount / lesson.totalEnrolled) * 100)
                    : 0;
                const isLowCompletion = lesson.totalEnrolled > 0 && pct < 50;
                return (
                  <tr
                    key={lesson.lessonId}
                    className={`border-b border-border last:border-0 ${
                      isLowCompletion ? "bg-warning-bg" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5 text-text-primary">{lesson.title}</td>
                    <td className="px-4 py-2.5 text-text-muted">
                      {lesson.completedCount}/{lesson.totalEnrolled}
                    </td>
                    <td
                      className={`px-4 py-2.5 font-medium ${
                        isLowCompletion ? "text-warning" : "text-text-primary"
                      }`}
                    >
                      {pct}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-text-primary">Top students</p>
        </div>
        {analytics.topStudents.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">No enrollments yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {analytics.topStudents.map((student) => (
              <div key={student.userId} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {student.name ?? "Anonymous"}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="h-1.5 flex-1 max-w-40 rounded-full bg-surface-3 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand transition-all"
                        style={{ width: `${student.progress}%` }}
                      />
                    </div>
                    <span className="text-xs text-text-muted shrink-0">{student.progress}%</span>
                  </div>
                </div>
                <span className="text-xs text-text-muted shrink-0">
                  {student.lastActive
                    ? `Active ${new Date(student.lastActive).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}`
                    : "No activity yet"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
