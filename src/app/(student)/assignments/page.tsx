import { auth } from "@clerk/nextjs/server";
import { format } from "date-fns";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EmptyState } from "@/components";
import { db } from "@/lib/db";
import { getStudentAssignments, type StudentAssignmentStatus } from "@/lib/student-assignments";

const STATUS_CONFIG: Record<StudentAssignmentStatus, { label: string; className: string }> = {
  OVERDUE: { label: "Overdue", className: "bg-danger-bg text-danger" },
  NOT_SUBMITTED: { label: "Not submitted", className: "bg-warning-bg text-warning" },
  LATE: { label: "Late", className: "bg-warning-bg text-warning" },
  SUBMITTED: { label: "Submitted", className: "bg-brand-light text-brand" },
  GRADED: { label: "Graded", className: "bg-success-bg text-success" },
};

export default async function AssignmentsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  const assignments = await getStudentAssignments(dbUser.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1
          className="text-xl font-semibold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Assignments
        </h1>
        <p className="text-sm text-text-muted">
          Every assignment across your enrolled courses, sorted by what needs attention first.
        </p>
      </div>

      {assignments.length === 0 ? (
        <EmptyState
          icon="📝"
          title="No assignments yet"
          description="Enroll in a course with assignments to see them here."
          ctaLabel="Browse courses"
          ctaHref="/courses"
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {assignments.map((item) => {
            const config = STATUS_CONFIG[item.status];
            return (
              <li key={item.assignmentId}>
                <Link
                  href={`/courses/${item.courseSlug}/lessons/${item.lessonSlug}`}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border bg-white p-4 shadow-sm transition-colors hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{item.title}</p>
                    <p className="mt-0.5 text-xs text-text-muted">{item.courseTitle}</p>
                    {item.dueDate && (
                      <p className="mt-1 text-xs text-text-muted">
                        Due {format(item.dueDate, "MMM d, yyyy")}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${config.className}`}
                    >
                      {config.label}
                    </span>
                    {item.score !== null && (
                      <span className="text-xs text-text-muted">
                        {item.score}/{item.maxScore}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
