import type { EnrollmentStatus } from "@/generated/prisma/client";

export type AssignmentStatus = "CANCELLED" | "COMPLETED" | "OVERDUE" | "STARTED" | "ASSIGNED";

export type AssignmentStatusInput = {
  cancelledAt: Date | null;
  dueDate: Date | null;
  // The learner's Enrollment.status for the assignment's course, or null when
  // no enrollment row exists.
  enrollmentStatus: EnrollmentStatus | null;
  // Whether any LessonProgress row exists for the learner on the course.
  hasLessonProgress: boolean;
  now: Date;
};

/**
 * Assignment status is never stored — it is derived from facts the platform
 * already owns (the assignment's cancellation and due date, the learner's
 * Enrollment, and their LessonProgress). First match wins:
 *
 *   1. cancelled                        -> CANCELLED
 *   2. enrollment completed             -> COMPLETED
 *   3. due date is in the past          -> OVERDUE
 *   4. any LessonProgress row exists    -> STARTED
 *   5. otherwise                        -> ASSIGNED
 *
 * Pure and clock-free: `now` is always supplied by the caller.
 * `Enrollment.lastAccessed` is deliberately not an input — it is never
 * written anywhere, so it cannot indicate a start.
 */
export function deriveAssignmentStatus(input: AssignmentStatusInput): AssignmentStatus {
  if (input.cancelledAt !== null) return "CANCELLED";
  if (input.enrollmentStatus === "COMPLETED") return "COMPLETED";
  if (input.dueDate !== null && input.dueDate.getTime() < input.now.getTime()) return "OVERDUE";
  if (input.hasLessonProgress) return "STARTED";
  return "ASSIGNED";
}
