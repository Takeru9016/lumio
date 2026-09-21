import { AuthContextError, requireAuthContext, requireRole } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { canEnrollInCourse } from "@/lib/domain/course/enrollmentAccess";
import { getLearnerPrerequisiteStatuses } from "@/lib/domain/course/prerequisites";

/**
 * Where the signed-in learner stands on a course's prerequisites (Phase 29.2), for
 * the course page to explain what is still required.
 *
 * Self-scoped and read-only: the learner is always the resolved session user, and
 * the handler reads nothing from the URL or body but the course slug, so another
 * learner's progress cannot be asked for. `courseId` is the Course.slug, like every
 * sibling route under /api/courses/[courseId]/*.
 *
 * A course the learner could not see anyway (unknown, a draft, another tenant's, or
 * an archived one they never enrolled in) is one uniform 404, so neither the course
 * nor its prerequisites can be probed for. This route reports; it is not what
 * enforces: enrollment, payment and assignment do that themselves.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  try {
    const ctx = await requireAuthContext();
    requireRole(ctx, ["STUDENT"]);

    const { courseId: slug } = await params;
    const course = await db.course.findUnique({
      where: { slug },
      select: { id: true, status: true, tenantId: true },
    });
    if (!course || course.status === "DRAFT" || !canEnrollInCourse(course.tenantId, ctx.tenantId)) {
      return Response.json({ error: "Course not found" }, { status: 404 });
    }
    if (course.status === "ARCHIVED") {
      const enrollment = await db.enrollment.findUnique({
        where: { userId_courseId: { userId: ctx.userId, courseId: course.id } },
        select: { id: true },
      });
      if (!enrollment) return Response.json({ error: "Course not found" }, { status: 404 });
    }

    const prerequisites = await getLearnerPrerequisiteStatuses(db, {
      userId: ctx.userId,
      courseId: course.id,
    });
    return Response.json({ prerequisites });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[prerequisites] Failed to load prerequisite status", err);
    return Response.json({ error: "Failed to load prerequisites" }, { status: 500 });
  }
}
