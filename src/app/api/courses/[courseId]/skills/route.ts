import { AuthContextError, requireAuthContext, requireRole } from "@/lib/auth/context";
import {
  addCourseSkill,
  CourseSkillManagementError,
  listCourseSkills,
} from "@/lib/domain/capability/courseSkillManagement";

/**
 * Shared by both the instructor course editor and the org admin course
 * surface (Phase 22 locked contract) — authorization branches inside
 * courseSkillManagement.ts's resolveAuthorizedCourse, not by route group, so
 * there is exactly one CourseSkill domain/API implementation for both
 * callers. `courseId` is the Course.slug, matching every sibling route
 * under /api/courses/[courseId]/*.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
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

  const { courseId } = await params;

  try {
    const skills = await listCourseSkills(ctx, courseId);
    return Response.json({ skills });
  } catch (err) {
    if (err instanceof CourseSkillManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[course-skills] Failed to list course skills", err);
    return Response.json({ error: "Failed to list course skills" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ courseId: string }> }) {
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

  const { courseId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const skill = await addCourseSkill(ctx, courseId, body as { skillId: unknown });
    return Response.json(skill, { status: 201 });
  } catch (err) {
    if (err instanceof CourseSkillManagementError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[course-skills] Failed to add course skill", err);
    return Response.json({ error: "Failed to add course skill" }, { status: 500 });
  }
}
