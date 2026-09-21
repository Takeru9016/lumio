import type { CourseStatus, EnrollmentStatus } from "@/generated/prisma/enums";
import { isCourseAvailable } from "@/lib/domain/learning-path/availability";

/**
 * A learner's progress through a path is derived, every time it is read, from the
 * course Enrollments they already have. Nothing about it is stored: there is no
 * path enrollment, no path progress and no path completion, so nothing can go stale
 * when a course is added, removed or retired after a learner started.
 */

export type MemberProgressInput = {
  courseId: string;
  status: CourseStatus;
  /** At least one published, non-archived lesson. */
  hasPublishedLesson: boolean;
  /** The learner's own enrollment status for the course, or null when there is none. */
  enrollmentStatus: EnrollmentStatus | null;
};

/**
 * - COMPLETED: the learner's Enrollment is COMPLETED, whatever the course is now
 *   (completion outranks retirement, as it does for prerequisites)
 * - AVAILABLE: not completed, and the course is PUBLISHED with a lesson to complete
 * - UNAVAILABLE: anything else. It cannot be completed today, so it is left out of
 *   the count rather than holding the learner at less than 100%
 *
 * ACTIVE and REFUNDED enrollments are not completions.
 */
export type MemberProgressState = "COMPLETED" | "AVAILABLE" | "UNAVAILABLE";

export type PathProgress = {
  members: { courseId: string; state: MemberProgressState }[];
  completed: number;
  /** COMPLETED + AVAILABLE. */
  total: number;
  /** Whole percent, or null when there is nothing to complete (never 0, never 100). */
  percent: number | null;
  /** True only when there is something to complete and all of it is completed. */
  complete: boolean;
};

function memberState(member: MemberProgressInput): MemberProgressState {
  if (member.enrollmentStatus === "COMPLETED") return "COMPLETED";
  return isCourseAvailable(member) ? "AVAILABLE" : "UNAVAILABLE";
}

export function derivePathProgress(members: readonly MemberProgressInput[]): PathProgress {
  const states = members.map((member) => ({
    courseId: member.courseId,
    state: memberState(member),
  }));
  const completed = states.filter((m) => m.state === "COMPLETED").length;
  const total = completed + states.filter((m) => m.state === "AVAILABLE").length;
  return {
    members: states,
    completed,
    total,
    percent: total === 0 ? null : Math.round((completed / total) * 100),
    complete: total > 0 && completed === total,
  };
}
