import { auth } from "@clerk/nextjs/server";
import { format } from "date-fns";
import { ClipboardList, Users } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getInstructorStudents } from "@/lib/instructor-students";

import { type SubmissionItem, SubmissionsGrader } from "./_components/SubmissionsGrader";

export default async function InstructorStudentsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  // ── Enrolled students (rolled up per student, across all their courses) ───
  const enrolledStudents = await getInstructorStudents(dbUser.id);

  // ── Submissions to grade ───────────────────────────────────────────────────
  const rawSubmissions = await db.assignmentSubmission.findMany({
    where: {
      status: { in: ["SUBMITTED", "LATE"] },
      assignment: {
        lesson: {
          section: { course: { instructorId: dbUser.id } },
        },
      },
    },
    select: {
      id: true,
      status: true,
      textContent: true,
      fileUrl: true,
      submittedAt: true,
      user: { select: { name: true, email: true } },
      assignment: {
        select: {
          id: true,
          title: true,
          maxScore: true,
          lesson: {
            select: {
              title: true,
              section: {
                select: {
                  course: { select: { title: true } },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { submittedAt: "asc" },
  });

  const submissions: SubmissionItem[] = rawSubmissions.map((s) => ({
    id: s.id,
    status: s.status as "SUBMITTED" | "LATE",
    textContent: s.textContent,
    fileUrl: s.fileUrl,
    submittedAt: s.submittedAt.toISOString(),
    studentName: s.user.name,
    studentEmail: s.user.email,
    assignmentId: s.assignment.id,
    assignmentTitle: s.assignment.title,
    maxScore: s.assignment.maxScore,
    courseTitle: s.assignment.lesson.section.course.title,
    lessonTitle: s.assignment.lesson.title,
  }));

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-surface-3">
          <Users size={18} className="text-text-muted" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Students</h1>
          <p className="text-sm text-text-muted">
            {enrolledStudents.length} enrolled · {submissions.length} submission
            {submissions.length !== 1 ? "s" : ""} to grade
          </p>
        </div>
      </div>

      {/* Enrolled students */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Enrolled Students</h2>

        {enrolledStudents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
            <Users size={28} className="text-text-disabled mx-auto mb-2" />
            <p className="text-sm font-medium text-text-primary mb-1">No students yet</p>
            <p className="text-xs text-text-muted">
              Students who enroll in your courses will appear here.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-secondary">
                    Student
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-secondary">
                    Courses
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-secondary">
                    Enrolled
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-secondary">
                    Last active
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-text-secondary">
                    Quiz avg
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-text-secondary">
                    Progress
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {enrolledStudents.map((s) => (
                  <tr key={s.userId} className="bg-surface-1 hover:bg-surface-2 transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/instructor/students/${s.userId}`} className="hover:underline">
                        <p className="font-medium text-text-primary truncate max-w-[160px]">
                          {s.name ?? s.email}
                        </p>
                        {s.name && (
                          <p className="text-xs text-text-muted truncate max-w-[160px]">
                            {s.email}
                          </p>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-text-secondary truncate max-w-[180px]">
                      {s.courseCount === 1 ? s.courseTitles[0] : `${s.courseCount} courses`}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs whitespace-nowrap">
                      {format(s.enrolledAt, "MMM d, yyyy")}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs whitespace-nowrap">
                      {s.lastAccessed ? format(s.lastAccessed, "MMM d, yyyy") : "—"}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs text-right whitespace-nowrap">
                      {s.quizAvg != null ? `${s.quizAvg}%` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-brand rounded-full"
                            style={{ width: `${s.avgProgress}%` }}
                          />
                        </div>
                        <span className="text-xs text-text-muted w-8 text-right">
                          {s.avgProgress}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Submissions to grade */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <ClipboardList size={14} className="text-text-muted" />
          Submissions to grade
        </h2>
        <SubmissionsGrader initialSubmissions={submissions} />
      </div>
    </div>
  );
}
