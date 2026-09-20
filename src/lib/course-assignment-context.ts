import type { AuthContext } from "@/lib/auth/context";
import { getLearnerCourseAssignment } from "@/lib/domain/learning-assignment/learnerAssignments";
import { type AssignmentItem, itemFromLearnerAssignment } from "@/lib/learner-assignment-view";

type CourseViewer = Pick<AuthContext, "userId" | "clerkId" | "tenantId" | "role">;

/**
 * The learner's assignment for the course they are looking at, for the small
 * "Assigned learning" note on the course page.
 *
 * It goes through the same row-to-learner mapping as GET /api/assignments/me, so
 * the status and reason here can never disagree with the dashboard, but it asks
 * the database for this one course only rather than the whole collection. It is best-effort by
 * design: only an organisation learner can have assignments, and a failure here
 * must never stop a course page from rendering, so every "no" answer (wrong
 * role, no organisation, no assignment, a failed read) is simply `null`.
 *
 * When a course has more than one assignment (for example a manual one and a
 * mandatory one) the read model's own order decides, so the earliest due date
 * wins and the choice is the same on every load.
 */
export async function getCourseAssignmentContext(
  viewer: CourseViewer,
  courseId: string
): Promise<AssignmentItem | null> {
  if (viewer.role !== "STUDENT" || !viewer.tenantId) return null;

  try {
    const assignment = await getLearnerCourseAssignment(viewer, courseId);
    return assignment ? itemFromLearnerAssignment(assignment) : null;
  } catch {
    return null;
  }
}
