import { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";

export class CourseSkillManagementError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string
  ) {
    super(message);
    this.name = "CourseSkillManagementError";
  }
}

export type CourseSkillItem = {
  skillId: string;
  skillName: string;
  skillDescription: string | null;
};

/**
 * The single authorization boundary for every CourseSkill mutation/read in
 * this module (Phase 22 locked contract §"COURSE OWNERSHIP / TENANT
 * SECURITY"). `courseSlug` matches every sibling route under
 * /api/courses/[courseId]/* (sections, publish, archive, analytics), which
 * all resolve the `[courseId]` route param via Course.slug, not Course.id.
 *
 * INSTRUCTOR must own the course (matches the existing 404-if-missing,
 * 403-if-not-owned convention those sibling routes already use). ORG_ADMIN
 * is scoped by folding the tenant check directly into the query's WHERE
 * clause, so a cross-tenant course simply doesn't match — never
 * distinguishing "exists in another tenant" from "doesn't exist" (same
 * not-found-over-forbidden posture Phase 19's resolveTenantRole/
 * resolveTenantSkill already use for tenant-scoped resources).
 */
async function resolveAuthorizedCourse(
  ctx: AuthContext,
  courseSlug: string
): Promise<{ id: string; tenantId: string | null }> {
  if (ctx.role === "INSTRUCTOR") {
    const course = await db.course.findUnique({
      where: { slug: courseSlug },
      select: { id: true, tenantId: true, instructorId: true },
    });
    if (!course) throw new CourseSkillManagementError(404, "Course not found");
    if (course.instructorId !== ctx.userId) {
      throw new CourseSkillManagementError(403, "Forbidden");
    }
    return course;
  }

  if (ctx.role === "ORG_ADMIN") {
    if (!ctx.tenantId) throw new CourseSkillManagementError(404, "Course not found");
    const course = await db.course.findFirst({
      where: { slug: courseSlug, tenantId: ctx.tenantId },
      select: { id: true, tenantId: true },
    });
    if (!course) throw new CourseSkillManagementError(404, "Course not found");
    return course;
  }

  throw new CourseSkillManagementError(403, "Forbidden");
}

export async function listCourseSkills(
  ctx: AuthContext,
  courseSlug: string
): Promise<CourseSkillItem[]> {
  const course = await resolveAuthorizedCourse(ctx, courseSlug);

  const mappings = await db.courseSkill.findMany({
    where: { courseId: course.id },
    select: { skillId: true, skill: { select: { name: true, description: true } } },
    orderBy: { createdAt: "asc" },
  });

  return mappings.map((m) => ({
    skillId: m.skillId,
    skillName: m.skill.name,
    skillDescription: m.skill.description,
  }));
}

/**
 * Adds one CourseSkill mapping. `skillId` is re-verified against the
 * course's own tenant (never the caller's) and must be ACTIVE — the same
 * tenant-trust posture the AI Course Creator save flow already proves
 * (src/lib/domain/course-creator/saveDraft.ts's verifiedSkillIds), applied
 * here as the second, general-purpose authoring path for CourseSkill. A
 * course with no tenant (a FREE-plan solo course) has no valid Skill to map
 * — there is no tenant-scoped Skill catalog to check against — so it always
 * 404s rather than querying with a null tenant filter.
 */
export async function addCourseSkill(
  ctx: AuthContext,
  courseSlug: string,
  input: { skillId: unknown }
): Promise<CourseSkillItem> {
  const course = await resolveAuthorizedCourse(ctx, courseSlug);

  if (typeof input.skillId !== "string" || input.skillId.length === 0) {
    throw new CourseSkillManagementError(400, "skillId is required");
  }

  if (!course.tenantId) throw new CourseSkillManagementError(404, "Skill not found");

  const skill = await db.skill.findFirst({
    where: { id: input.skillId, tenantId: course.tenantId, status: "ACTIVE" },
    select: { id: true, name: true, description: true },
  });
  if (!skill) throw new CourseSkillManagementError(404, "Skill not found");

  try {
    await db.courseSkill.create({ data: { courseId: course.id, skillId: skill.id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new CourseSkillManagementError(409, "This skill is already mapped to this course");
    }
    throw err;
  }

  return { skillId: skill.id, skillName: skill.name, skillDescription: skill.description };
}

/**
 * Removes one CourseSkill mapping. This only prevents future qualifying
 * outcomes (src/lib/domain/capability/outcomes.ts) from creating new
 * evidence for this course/skill pair — it never touches existing
 * SkillEvidence/UserSkill rows, which remain historical fact (Phase 22
 * locked contract §"REMOVING A COURSE-SKILL MAPPING").
 */
export async function removeCourseSkill(
  ctx: AuthContext,
  courseSlug: string,
  skillId: string
): Promise<void> {
  const course = await resolveAuthorizedCourse(ctx, courseSlug);

  const existing = await db.courseSkill.findFirst({ where: { courseId: course.id, skillId } });
  if (!existing)
    throw new CourseSkillManagementError(404, "This skill is not mapped to this course");

  await db.courseSkill.delete({ where: { courseId_skillId: { courseId: course.id, skillId } } });
}
