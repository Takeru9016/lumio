import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import {
  addCourseSkill,
  CourseSkillManagementError,
  listCourseSkills,
  removeCourseSkill,
} from "@/lib/domain/capability/courseSkillManagement";
import { recordCourseCompletionOutcome } from "@/lib/domain/capability/outcomes";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function enroll(userId: string, courseId: string) {
  return db.enrollment.create({ data: { userId, courseId } });
}

describe("listCourseSkills / addCourseSkill / removeCourseSkill — authorization matrix", () => {
  it("INSTRUCTOR who owns the course can list/add/remove", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);
    const skill = await createSkill(tenant.id);

    const added = await addCourseSkill(ctx, course.slug, { skillId: skill.id });
    expect(added.skillId).toBe(skill.id);

    const list = await listCourseSkills(ctx, course.slug);
    expect(list.map((s) => s.skillId)).toEqual([skill.id]);

    await removeCourseSkill(ctx, course.slug, skill.id);
    expect(await listCourseSkills(ctx, course.slug)).toHaveLength(0);
  });

  it("INSTRUCTOR who does not own the course is denied with 403", async () => {
    const { tenant, ctx: ownerCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: otherInstructorCtx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ownerCtx.userId);
    const skill = await createSkill(tenant.id);

    await expect(listCourseSkills(otherInstructorCtx, course.slug)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      addCourseSkill(otherInstructorCtx, course.slug, { skillId: skill.id })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      removeCourseSkill(otherInstructorCtx, course.slug, skill.id)
    ).rejects.toMatchObject({ status: 403 });
  });

  it("INSTRUCTOR — nonexistent course slug -> 404", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    await expect(listCourseSkills(ctx, "does-not-exist")).rejects.toMatchObject({ status: 404 });
  });

  it("INSTRUCTOR — cross-tenant skill is denied with 404 (never mapped to another tenant's Skill)", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser();
    const { course } = await createCourse(tenant.id, ctx.userId);
    const crossTenantSkill = await createSkill(otherTenant.id);

    await expect(
      addCourseSkill(ctx, course.slug, { skillId: crossTenantSkill.id })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("INSTRUCTOR — inactive (ARCHIVED) skill is denied with 404", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);
    const skill = await createSkill(tenant.id);
    await db.skill.update({ where: { id: skill.id }, data: { status: "ARCHIVED" } });

    await expect(addCourseSkill(ctx, course.slug, { skillId: skill.id })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("ORG_ADMIN in the same tenant can list/add/remove for any course in that tenant", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    // Re-point the org admin at the same tenant as the course's instructor.
    const sameTenantOrgAdminCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);

    const added = await addCourseSkill(sameTenantOrgAdminCtx, course.slug, { skillId: skill.id });
    expect(added.skillId).toBe(skill.id);

    const list = await listCourseSkills(sameTenantOrgAdminCtx, course.slug);
    expect(list.map((s) => s.skillId)).toEqual([skill.id]);

    await removeCourseSkill(sameTenantOrgAdminCtx, course.slug, skill.id);
    expect(await listCourseSkills(sameTenantOrgAdminCtx, course.slug)).toHaveLength(0);
  });

  it("ORG_ADMIN in a different tenant is denied with 404 — never leaks the other tenant's course existence", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: otherOrgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);

    await expect(listCourseSkills(otherOrgAdminCtx, course.slug)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      addCourseSkill(otherOrgAdminCtx, course.slug, { skillId: skill.id })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("ORG_ADMIN — cross-tenant skill is denied with 404", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const sameTenantOrgAdminCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const { tenant: otherTenant } = await createTenantUser();
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const crossTenantSkill = await createSkill(otherTenant.id);

    await expect(
      addCourseSkill(sameTenantOrgAdminCtx, course.slug, { skillId: crossTenantSkill.id })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("ORG_ADMIN — inactive skill is denied with 404", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const sameTenantOrgAdminCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await db.skill.update({ where: { id: skill.id }, data: { status: "ARCHIVED" } });

    await expect(
      addCourseSkill(sameTenantOrgAdminCtx, course.slug, { skillId: skill.id })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("STUDENT is denied with 403 — no new SUPER_ADMIN/STUDENT access", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: studentCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);

    await expect(listCourseSkills(studentCtx, course.slug)).rejects.toMatchObject({ status: 403 });
  });

  it("SUPER_ADMIN is denied with 403 — this phase adds no new SUPER_ADMIN access", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: superAdminCtx } = await createTenantUser("SUPER_ADMIN");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);

    await expect(listCourseSkills(superAdminCtx, course.slug)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("addCourseSkill / removeCourseSkill — edge cases and integrity", () => {
  it("malformed skillId (empty string) -> 400", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);

    await expect(addCourseSkill(ctx, course.slug, { skillId: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(addCourseSkill(ctx, course.slug, { skillId: undefined })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("nonexistent skillId -> 404", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);

    await expect(
      addCourseSkill(ctx, course.slug, { skillId: "does-not-exist" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("duplicate mapping -> 409, and does not create a second CourseSkill row", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);

    await expect(addCourseSkill(ctx, course.slug, { skillId: skill.id })).rejects.toMatchObject({
      status: 409,
    });

    const rows = await db.courseSkill.findMany({
      where: { courseId: course.id, skillId: skill.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("removing a nonexistent mapping -> 404", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);
    const skill = await createSkill(tenant.id);

    await expect(removeCourseSkill(ctx, course.slug, skill.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("a course with no tenant (FREE-plan solo course) can never have a skill mapped", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const course = await db.course.create({
      data: { title: "solo", slug: `solo-${Date.now()}`, instructorId: ctx.userId, tenantId: null },
    });

    await expect(addCourseSkill(ctx, course.slug, { skillId: "anything" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("a tenant with zero skills -> listCourseSkills returns an empty array, not an error", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);

    expect(await listCourseSkills(ctx, course.slug)).toEqual([]);
  });

  it("multiple skills on one course; removing one preserves the others", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    const skillC = await createSkill(tenant.id);
    await addCourseSkill(ctx, course.slug, { skillId: skillA.id });
    await addCourseSkill(ctx, course.slug, { skillId: skillB.id });
    await addCourseSkill(ctx, course.slug, { skillId: skillC.id });

    await removeCourseSkill(ctx, course.slug, skillB.id);

    const remaining = (await listCourseSkills(ctx, course.slug)).map((s) => s.skillId).sort();
    expect(remaining).toEqual([skillA.id, skillC.id].sort());
  });

  it("CourseSkillManagementError carries the expected status/message shape", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, ctx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);

    try {
      await addCourseSkill(ctx, course.slug, { skillId: skill.id });
      throw new Error("expected addCourseSkill to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CourseSkillManagementError);
      expect((err as CourseSkillManagementError).status).toBe(409);
    }
  });
});

describe("Historical evidence rules (Phase 22 locked contract)", () => {
  it("Scenario A — mapping before completion: a qualifying completion creates evidence", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });
    const enrollment = await enroll(learnerCtx.userId, course.id);

    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: enrollment.id,
      completedAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(1);
  });

  it("Scenario B — mapping after completion: no historical evidence is created retroactively", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const enrollment = await enroll(learnerCtx.userId, course.id);

    // Completion happens BEFORE the skill is ever mapped.
    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: enrollment.id,
      completedAt: new Date(),
    });

    // The mapping is added only afterward, through the new authoring path.
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(0);
  });

  it("Scenario C — mapping removal does not alter existing historical SkillEvidence/UserSkill", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });
    const enrollment = await enroll(learnerCtx.userId, course.id);

    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: enrollment.id,
      completedAt: new Date(),
    });

    const evidenceBefore = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    const userSkillBefore = await db.userSkill.findFirst({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidenceBefore).toHaveLength(1);
    expect(userSkillBefore).not.toBeNull();

    await removeCourseSkill(instructorCtx, course.slug, skill.id);

    const evidenceAfter = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    const userSkillAfter = await db.userSkill.findFirst({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidenceAfter).toEqual(evidenceBefore);
    expect(userSkillAfter).toEqual(userSkillBefore);
  });

  it("Scenario D — a future qualifying outcome after removal creates no new evidence", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });
    await removeCourseSkill(instructorCtx, course.slug, skill.id);

    const enrollment = await enroll(learnerCtx.userId, course.id);
    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: enrollment.id,
      completedAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(0);
  });
});

describe("Phase 22 — central Learning -> CourseSkill -> Evidence integration test", () => {
  it("a course mapped through the new domain path produces real, verifiable capability evidence, and removal never deletes it", async () => {
    // 1. tenant + instructor + learner
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");

    // 2. course
    const { course } = await createCourse(tenant.id, instructorCtx.userId);

    // 3. skill
    const skill = await createSkill(tenant.id);

    // 4. CourseSkill added through the new domain/API path (not a raw fixture insert)
    const added = await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });
    expect(added.skillId).toBe(skill.id);

    // 5. learner enrolled
    const enrollment = await enroll(learnerCtx.userId, course.id);

    // 6. qualifying learning outcome occurs — via the real, unmodified outcome pipeline
    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: enrollment.id,
      completedAt: new Date(),
    });

    // 7. the existing evidence pipeline creates SkillEvidence
    const evidence = await db.skillEvidence.findFirst({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).not.toBeNull();
    expect(evidence?.type).toBe("COURSE_COMPLETION");
    expect(evidence?.verificationStatus).toBe("UNVERIFIED");

    // 8. evidence is available to the existing capability system (UserSkill projection)
    const userSkill = await db.userSkill.findFirst({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(userSkill).not.toBeNull();
    expect(userSkill?.proficiency).toBe("BEGINNER");

    // Removal never deletes historical evidence.
    await removeCourseSkill(instructorCtx, course.slug, skill.id);
    const evidenceAfterRemoval = await db.skillEvidence.findFirst({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidenceAfterRemoval).not.toBeNull();
    expect(evidenceAfterRemoval?.id).toBe(evidence?.id);
  });
});
