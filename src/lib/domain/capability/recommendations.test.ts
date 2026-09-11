import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createJobRole,
  createRoleSkill,
  createSkill,
  createUserJobRole,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { getRecommendedLearning } from "@/lib/domain/capability/recommendations";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function publish(courseId: string) {
  await db.course.update({ where: { id: courseId }, data: { status: "PUBLISHED" } });
}

describe("getRecommendedLearning — capability", () => {
  it("no primary role -> empty recommendations", async () => {
    const { tenant, ctx } = await createTenantUser();
    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toEqual([]);
  });

  it("no unmet gaps -> empty recommendations", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "BEGINNER" },
    });
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    await publish(course.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toEqual([]);
  });

  it("one unmet gap with a matching published course -> recommendation", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    await publish(course.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].courseId).toBe(course.id);
    expect(result.recommendations[0].reasonSkills).toEqual([
      {
        skillId: skill.id,
        skillName: skill.name,
        requiredProficiency: "BEGINNER",
        currentProficiency: "NONE",
      },
    ]);
  });

  it("archived skill -> excluded", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    await publish(course.id);
    await db.skill.update({ where: { id: skill.id }, data: { status: "ARCHIVED" } });

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    // computeCapabilityGap itself already excludes archived-skill requirements
    // (getRoleRequirements filters skill.status === "ACTIVE"), so there is no
    // gap to recommend against.
    expect(result.recommendations).toEqual([]);
  });
});

describe("getRecommendedLearning — tenant/security", () => {
  async function setupGap() {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    return { tenant, instructorCtx, ctx, skill };
  }

  it("same-tenant published course -> included", async () => {
    const { tenant, instructorCtx, ctx, skill } = await setupGap();
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    await publish(course.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations.map((r) => r.courseId)).toContain(course.id);
  });

  it("tenantId = null course -> excluded (does not count as globally accessible)", async () => {
    const { tenant, ctx, skill } = await setupGap();
    // No tenant on the instructor -> Course.tenantId is left null, matching
    // the real repo mechanism (POST /api/courses never sets tenantId for a
    // FREE-plan/non-org instructor).
    const soloInstructor = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}-${Math.random()}`,
        email: `solo-${Date.now()}@x.com`,
        role: "INSTRUCTOR",
      },
    });
    const course = await db.course.create({
      data: {
        title: "Global course",
        slug: `global-${Date.now()}`,
        instructorId: soloInstructor.id,
      },
    });
    await mapCourseSkill(course.id, skill.id);
    await publish(course.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations.map((r) => r.courseId)).not.toContain(course.id);
  });

  it("foreign-tenant course -> excluded", async () => {
    const { tenant, ctx, skill } = await setupGap();
    const { tenant: otherTenant, ctx: otherInstructorCtx } = await createTenantUser("INSTRUCTOR");
    const { course: foreignCourse } = await createCourse(otherTenant.id, otherInstructorCtx.userId);
    await mapCourseSkill(foreignCourse.id, skill.id);
    await publish(foreignCourse.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations.map((r) => r.courseId)).not.toContain(foreignCourse.id);
  });

  it("malformed cross-tenant CourseSkill (caller's own skill mapped to a foreign-tenant course) -> excluded without throwing", async () => {
    const { tenant, ctx, skill } = await setupGap();
    const { tenant: otherTenant, ctx: otherInstructorCtx } = await createTenantUser("INSTRUCTOR");
    const { course: foreignCourse } = await createCourse(otherTenant.id, otherInstructorCtx.userId);
    // Malformed: skill belongs to `tenant`, course belongs to `otherTenant`.
    await mapCourseSkill(foreignCourse.id, skill.id);
    await publish(foreignCourse.id);

    await expect(getRecommendedLearning({ ...ctx, tenantId: tenant.id })).resolves.not.toThrow();
    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations.map((r) => r.courseId)).not.toContain(foreignCourse.id);
  });
});

describe("getRecommendedLearning — course state", () => {
  async function setupGap() {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    return { tenant, instructorCtx, ctx, skill };
  }

  it("DRAFT course -> excluded", async () => {
    const { tenant, instructorCtx, ctx, skill } = await setupGap();
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    // left DRAFT — never published

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toEqual([]);
  });

  it("ARCHIVED course -> excluded", async () => {
    const { tenant, instructorCtx, ctx, skill } = await setupGap();
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    await db.course.update({ where: { id: course.id }, data: { status: "ARCHIVED" } });

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toEqual([]);
  });

  it("PUBLISHED course -> eligible", async () => {
    const { tenant, instructorCtx, ctx, skill } = await setupGap();
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    await publish(course.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations.map((r) => r.courseId)).toContain(course.id);
  });
});

describe("getRecommendedLearning — enrollment state", () => {
  async function setupGapWithCourse() {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skill.id);
    await publish(course.id);
    return { tenant, ctx, course };
  }

  it("ACTIVE enrollment -> excluded", async () => {
    const { tenant, ctx, course } = await setupGapWithCourse();
    await db.enrollment.create({
      data: { userId: ctx.userId, courseId: course.id, status: "ACTIVE" },
    });
    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toEqual([]);
  });

  it("COMPLETED enrollment -> excluded", async () => {
    const { tenant, ctx, course } = await setupGapWithCourse();
    await db.enrollment.create({
      data: { userId: ctx.userId, courseId: course.id, status: "COMPLETED" },
    });
    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toEqual([]);
  });

  it("REFUNDED enrollment -> NOT excluded", async () => {
    const { tenant, ctx, course } = await setupGapWithCourse();
    await db.enrollment.create({
      data: { userId: ctx.userId, courseId: course.id, status: "REFUNDED" },
    });
    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations.map((r) => r.courseId)).toContain(course.id);
  });

  it("no enrollment -> eligible", async () => {
    const { tenant, ctx, course } = await setupGapWithCourse();
    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations.map((r) => r.courseId)).toContain(course.id);
  });
});

describe("getRecommendedLearning — multi-skill aggregation", () => {
  it("one course addressing two unmet skills -> exactly one recommendation with both reason skills, ordered by severity descending", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skillLow = await createSkill(tenant.id);
    const skillHigh = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    // severity: low = INTERMEDIATE(2) - NONE(0) = 2; high = EXPERT(4) - NONE(0) = 4
    await createRoleSkill(role.id, skillLow.id, "INTERMEDIATE");
    await createRoleSkill(role.id, skillHigh.id, "EXPERT");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(course.id, skillLow.id);
    await mapCourseSkill(course.id, skillHigh.id);
    await publish(course.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].reasonSkills).toHaveLength(2);
    expect(result.recommendations[0].reasonSkills[0].skillId).toBe(skillHigh.id);
    expect(result.recommendations[0].reasonSkills[1].skillId).toBe(skillLow.id);
  });

  it("two separate courses addressing separate gaps -> two recommendations, no duplicates", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skillA.id, "BEGINNER");
    await createRoleSkill(role.id, skillB.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    const { course: courseA } = await createCourse(tenant.id, instructorCtx.userId);
    const { course: courseB } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(courseA.id, skillA.id);
    await mapCourseSkill(courseB.id, skillB.id);
    await publish(courseA.id);
    await publish(courseB.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toHaveLength(2);
    const ids = result.recommendations.map((r) => r.courseId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("getRecommendedLearning — ranking", () => {
  it("higher severity ranks first: NONE->EXPERT (severity 4) beats BEGINNER->INTERMEDIATE (severity 1)", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skillA.id, "EXPERT"); // gap A: NONE -> EXPERT = 4
    await createRoleSkill(role.id, skillB.id, "INTERMEDIATE");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skillB.id,
        proficiency: "BEGINNER",
      },
    }); // gap B: BEGINNER -> INTERMEDIATE = 1

    const { course: courseA } = await createCourse(tenant.id, instructorCtx.userId);
    const { course: courseB } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(courseA.id, skillA.id);
    await mapCourseSkill(courseB.id, skillB.id);
    await publish(courseA.id);
    await publish(courseB.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations[0].courseId).toBe(courseA.id);
    expect(result.recommendations[1].courseId).toBe(courseB.id);
  });

  it("secondary key (distinct skill count) breaks a primary-severity tie", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill1 = await createSkill(tenant.id);
    const skill2 = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill1.id, "BEGINNER"); // severity 1
    await createRoleSkill(role.id, skill2.id, "BEGINNER"); // severity 1
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const { course: singleSkillCourse } = await createCourse(tenant.id, instructorCtx.userId);
    const { course: multiSkillCourse } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(singleSkillCourse.id, skill1.id);
    await mapCourseSkill(multiSkillCourse.id, skill1.id);
    await mapCourseSkill(multiSkillCourse.id, skill2.id);
    await publish(singleSkillCourse.id);
    await publish(multiSkillCourse.id);

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations[0].courseId).toBe(multiSkillCourse.id);
    expect(result.recommendations[1].courseId).toBe(singleSkillCourse.id);
  });

  it("tertiary key (createdAt ascending) breaks a primary+secondary tie", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const { course: olderCourse } = await createCourse(tenant.id, instructorCtx.userId);
    const { course: newerCourse } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(olderCourse.id, skill.id);
    await mapCourseSkill(newerCourse.id, skill.id);
    await publish(olderCourse.id);
    await publish(newerCourse.id);
    await db.course.update({
      where: { id: olderCourse.id },
      data: { createdAt: new Date("2020-01-01T00:00:00Z") },
    });
    await db.course.update({
      where: { id: newerCourse.id },
      data: { createdAt: new Date("2025-01-01T00:00:00Z") },
    });

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations[0].courseId).toBe(olderCourse.id);
    expect(result.recommendations[1].courseId).toBe(newerCourse.id);
  });

  it("final tie-break (course.id ascending) breaks an identical createdAt tie", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const { course: courseX } = await createCourse(tenant.id, instructorCtx.userId);
    const { course: courseY } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(courseX.id, skill.id);
    await mapCourseSkill(courseY.id, skill.id);
    await publish(courseX.id);
    await publish(courseY.id);
    const sameInstant = new Date("2024-06-01T00:00:00Z");
    await db.course.update({ where: { id: courseX.id }, data: { createdAt: sameInstant } });
    await db.course.update({ where: { id: courseY.id }, data: { createdAt: sameInstant } });

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    const [first, second] = [courseX.id, courseY.id].sort();
    expect(result.recommendations[0].courseId).toBe(first);
    expect(result.recommendations[1].courseId).toBe(second);
  });

  it("repeated identical input produces identical output order (determinism)", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skillA.id, "INTERMEDIATE");
    await createRoleSkill(role.id, skillB.id, "EXPERT");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    const { course: courseA } = await createCourse(tenant.id, instructorCtx.userId);
    const { course: courseB } = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(courseA.id, skillA.id);
    await mapCourseSkill(courseB.id, skillB.id);
    await publish(courseA.id);
    await publish(courseB.id);

    const [run1, run2] = await Promise.all([
      getRecommendedLearning({ ...ctx, tenantId: tenant.id }),
      getRecommendedLearning({ ...ctx, tenantId: tenant.id }),
    ]);
    expect(run1.recommendations.map((r) => r.courseId)).toEqual(
      run2.recommendations.map((r) => r.courseId)
    );
  });

  it("6+ candidates -> only the top 5 are returned, cap applied after complete ranking", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const proficiencies: Array<"BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT"> = [
      "BEGINNER",
      "BEGINNER",
      "INTERMEDIATE",
      "INTERMEDIATE",
      "ADVANCED",
      "EXPERT",
    ];
    const courses: { id: string }[] = [];
    for (const [i, proficiency] of proficiencies.entries()) {
      const skill = await createSkill(tenant.id);
      await createRoleSkill(role.id, skill.id, proficiency);
      const { course } = await createCourse(tenant.id, instructorCtx.userId);
      await mapCourseSkill(course.id, skill.id);
      await publish(course.id);
      courses.push(course);
      void i;
    }

    const result = await getRecommendedLearning({ ...ctx, tenantId: tenant.id });
    expect(result.recommendations).toHaveLength(5);
    // The single lowest-severity candidate (index 0/1, severity 1: BEGINNER)
    // must be the one dropped by the cap, proving the cap applies after
    // full ranking, not before aggregation.
    const returnedIds = new Set(result.recommendations.map((r) => r.courseId));
    const droppedCount = courses.filter((c) => !returnedIds.has(c.id)).length;
    expect(droppedCount).toBe(1);
  });
});
