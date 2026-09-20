import { AuthContextError, requireAuthContext } from "@/lib/auth/context";
import { getLearnerAssignments } from "@/lib/domain/learning-assignment/learnerAssignments";

/**
 * The signed-in learner's own learning assignments (Phase 28.3).
 *
 * Read-only and self-scoped: the user and tenant always come from the resolved
 * AuthContext. The handler takes no request argument at all, so a `?userId=` or
 * `?tenantId=` in the URL cannot influence the query — that is structural, not
 * just tested. Authorization (student role, a tenant) and the tenant/user
 * scoping of the query live in getLearnerAssignments.
 *
 * Note: this path is unrelated to /api/assignments/[assignmentId], which
 * belongs to instructor-graded homework (the Assignment model). A learning
 * assignment is the LearningAssignment model — an organisation assigning a
 * course to a learner.
 */
export async function GET() {
  try {
    const ctx = await requireAuthContext();
    const assignments = await getLearnerAssignments(ctx);
    return Response.json({ assignments });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[assignments] Failed to load learner assignments", err);
    return Response.json({ error: "Failed to load assignments" }, { status: 500 });
  }
}
