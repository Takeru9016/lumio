import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ClipboardList } from "lucide-react";

import { db } from "@/lib";

import {
  SubmissionsGrader,
  type SubmissionItem,
} from "./_components/SubmissionsGrader";

export default async function InstructorStudentsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

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
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-surface-3">
          <ClipboardList size={18} className="text-text-muted" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Students</h1>
          <p className="text-sm text-text-muted">
            {submissions.length} submission
            {submissions.length !== 1 ? "s" : ""} waiting for a grade
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">
          Submissions to grade
        </h2>
        <SubmissionsGrader initialSubmissions={submissions} />
      </div>
    </div>
  );
}
