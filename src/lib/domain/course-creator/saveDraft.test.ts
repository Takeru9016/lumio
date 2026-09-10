import { afterAll, describe, expect, it } from "vitest";
import { AuthContextError } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { CourseAuthorizationError } from "@/lib/domain/course/authorization";
import { saveCourseDraft } from "@/lib/domain/course-creator/saveDraft";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

const validInput = {
  title: "B2B Sales Fundamentals",
  description: "A course that teaches new sales employees how to qualify B2B leads.",
  learningObjectives: ["Qualify a B2B lead"],
  targetSkillIds: [] as string[],
  sections: [
    {
      title: "Getting started",
      lessons: [{ title: "What is B2B sales?", contentType: "TEXT" as const }],
    },
  ],
};

describe("saveCourseDraft — the human/application save boundary", () => {
  it("creates a DRAFT course with tenant/creator derived from AuthContext, never from input", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");

    const course = await saveCourseDraft(ctx, validInput);

    expect(course.status).toBe("DRAFT");
    expect(course.tenantId).toBe(tenant.id);
    expect(course.instructorId).toBe(ctx.userId);
    expect(course.title).toBe(validInput.title);
  });

  it("forces DRAFT status regardless of any client-supplied value (schema doesn't even accept the field)", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const withStatus = { ...validInput, status: "PUBLISHED" };
    await expect(saveCourseDraft(ctx, withStatus)).rejects.toThrow();
  });

  it("creates Sections and Lessons in a single transaction, correctly nested", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const input = {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [
            { title: "A1", contentType: "TEXT" as const },
            { title: "A2", contentType: "VIDEO" as const },
          ],
        },
        { title: "Section B", lessons: [{ title: "B1", contentType: "QUIZ" as const }] },
      ],
    };

    const course = await saveCourseDraft(ctx, input);

    const sections = await db.section.findMany({
      where: { courseId: course.id },
      include: { lessons: true },
      orderBy: { order: "asc" },
    });
    expect(sections).toHaveLength(2);
    expect(sections[0].lessons).toHaveLength(2);
    expect(sections[1].lessons).toHaveLength(1);
    expect(sections[0].lessons.every((l) => l.isPublished === false)).toBe(true);
  });

  it("verifies every targetSkillId belongs to the caller's own tenant — a cross-tenant id is silently dropped, not trusted", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser("INSTRUCTOR");

    const ownSkill = await db.skill.create({
      data: { tenantId: tenant.id, name: "Own skill", slug: `own-skill-${Date.now()}` },
    });
    const otherSkill = await db.skill.create({
      data: {
        tenantId: otherTenant.id,
        name: "Other tenant skill",
        slug: `other-skill-${Date.now()}`,
      },
    });

    const course = await saveCourseDraft(ctx, {
      ...validInput,
      targetSkillIds: [ownSkill.id, otherSkill.id],
    });

    const courseSkills = await db.courseSkill.findMany({ where: { courseId: course.id } });
    expect(courseSkills.map((cs) => cs.skillId)).toEqual([ownSkill.id]);
  });

  it("rejects a non-INSTRUCTOR role, same as POST /api/courses", async () => {
    const { ctx } = await createTenantUser("STUDENT");
    await expect(saveCourseDraft(ctx, validInput)).rejects.toThrow(CourseAuthorizationError);
  });

  it("enforces the plan's maxCourses ceiling, same as POST /api/courses", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    // FREE plan (the fixture default) has maxCourses: 1.
    await db.course.create({
      data: {
        title: "Existing course",
        slug: `existing-${Date.now()}`,
        instructorId: ctx.userId,
        tenantId: tenant.id,
      },
    });

    await expect(saveCourseDraft(ctx, validInput)).rejects.toThrow(CourseAuthorizationError);
  });

  it("rejects a tenant-less AuthContext (FREE-plan solo user) rather than creating an unscoped course", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const tenantless = { ...ctx, tenantId: null };
    await expect(saveCourseDraft(tenantless, validInput)).rejects.toThrow(AuthContextError);
  });

  it("rejects malformed input before any write happens (no partial course structure)", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const before = await db.course.count({ where: { instructorId: ctx.userId } });

    await expect(saveCourseDraft(ctx, { title: "" })).rejects.toThrow();

    const after = await db.course.count({ where: { instructorId: ctx.userId } });
    expect(after).toBe(before);
  });
});
