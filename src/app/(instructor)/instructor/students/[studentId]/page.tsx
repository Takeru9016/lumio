import { auth } from "@clerk/nextjs/server";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getInstructorStudentDetail } from "@/lib/instructor-students";

interface InstructorStudentDetailPageProps {
  params: Promise<{ studentId: string }>;
}

export default async function InstructorStudentDetailPage({
  params,
}: InstructorStudentDetailPageProps) {
  const { studentId } = await params;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  const student = await getInstructorStudentDetail(dbUser.id, studentId);
  if (!student) notFound();

  const avgQuizScore =
    student.quizAttempts.length > 0
      ? Math.round(
          student.quizAttempts.reduce((sum, a) => sum + a.score, 0) / student.quizAttempts.length
        )
      : null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div>
        <Link
          href="/instructor/students"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          Back to students
        </Link>
        <h1 className="text-xl font-semibold font-heading text-text-primary">
          {student.name ?? student.email}
        </h1>
        {student.name && <p className="text-sm text-text-muted mt-1">{student.email}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Enrolled courses</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {student.courses.length}
          </p>
        </div>
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Quiz attempts</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {student.quizAttempts.length}
          </p>
        </div>
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Avg quiz score</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {avgQuizScore != null ? `${avgQuizScore}%` : "—"}
          </p>
        </div>
      </div>

      <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-text-primary">Courses</p>
        </div>
        <div className="divide-y divide-border">
          {student.courses.map((course) => (
            <div key={course.courseId} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/courses/${course.courseSlug}/analytics`}
                  className="text-sm font-medium text-text-primary hover:underline truncate block"
                >
                  {course.courseTitle}
                </Link>
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="h-1.5 flex-1 max-w-40 rounded-full bg-surface-3 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand transition-all"
                      style={{ width: `${course.progress}%` }}
                    />
                  </div>
                  <span className="text-xs text-text-muted shrink-0">{course.progress}%</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-text-muted">
                  Enrolled {format(course.enrolledAt, "MMM d, yyyy")}
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  {course.lastAccessed
                    ? `Active ${format(course.lastAccessed, "MMM d, yyyy")}`
                    : "No activity yet"}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-text-primary">Quiz attempts</p>
        </div>
        {student.quizAttempts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">No quiz attempts yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-border">
                <th className="px-4 py-2 font-medium">Quiz</th>
                <th className="px-4 py-2 font-medium">Course</th>
                <th className="px-4 py-2 font-medium">Completed</th>
                <th className="px-4 py-2 font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {student.quizAttempts.map((attempt) => (
                <tr key={attempt.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-text-primary">{attempt.quizTitle}</td>
                  <td className="px-4 py-2.5 text-text-muted">{attempt.courseTitle}</td>
                  <td className="px-4 py-2.5 text-text-muted">
                    {format(attempt.completedAt, "MMM d, yyyy")}
                  </td>
                  <td
                    className={`px-4 py-2.5 font-medium ${
                      attempt.isPassed ? "text-success" : "text-warning"
                    }`}
                  >
                    {attempt.score}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
