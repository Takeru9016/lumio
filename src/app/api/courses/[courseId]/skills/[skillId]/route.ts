import { AuthContextError, requireAuthContext, requireRole } from "@/lib/auth/context";
import {
  CourseSkillManagementError,
  removeCourseSkill,
} from "@/lib/domain/capability/courseSkillManagement";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ courseId: string; skillId: string }> }
) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireRole(ctx, ["INSTRUCTOR", "ORG_ADMIN"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { courseId, skillId } = await params;

  try {
    await removeCourseSkill(ctx, courseId, skillId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof CourseSkillManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[course-skills] Failed to remove course skill", err);
    return Response.json({ error: "Failed to remove course skill" }, { status: 500 });
  }
}
