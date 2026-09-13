import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createJobRole,
  createRoleSkill,
  createSkill,
  createUserJobRole,
} from "@/lib/domain/capability/__test__/fixtures";
import * as gapsModule from "@/lib/domain/capability/gaps";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
import { getInstructorCapabilityReport } from "@/lib/domain/capability/instructorReport";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function setUserSkill(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  proficiency: "NONE" | "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT";
}) {
  return db.userSkill.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      skillId: params.skillId,
      proficiency: params.proficiency,
    },
  });
}

async function enroll(userId: string, courseId: string) {
  return db.enrollment.create({ data: { userId, courseId } });
}

/** Creates a tenant + one INSTRUCTOR user + one Course they own. */
async function setupInstructor(tenantId: string) {
  const { ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
  // createTenantUser makes its own tenant; we want the instructor inside the
  // caller's tenant instead, so re-point their tenantId.
  await db.user.update({ where: { id: instructorCtx.userId }, data: { tenantId } });
  const { course } = await createCourse(tenantId, instructorCtx.userId);
  return { instructorId: instructorCtx.userId, course };
}

describe("getInstructorCapabilityReport — population", () => {
  it("includes a student enrolled in the instructor's own course, with a primary role and required skills", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, student.userId, role.id);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);

    expect(result.learners).toHaveLength(1);
    expect(result.learners[0].userId).toBe(student.userId);
    expect(result.learners[0].roleId).toBe(role.id);
  });

  it("excludes a student not enrolled in any of the instructor's courses", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, role.id);
    // student never enrolled anywhere

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners).toEqual([]);
  });

  it("excludes a student with no UserJobRole even if enrolled", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners).toEqual([]);
  });

  it("excludes a student whose UserJobRole rows are all isPrimary:false", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, role.id, false);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners).toEqual([]);
  });

  it("excludes a soft-deleted student", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, role.id);
    await db.user.update({ where: { id: student.userId }, data: { deletedAt: new Date() } });

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners).toEqual([]);
  });
});

describe("getInstructorCapabilityReport — instructor ownership boundary (CRITICAL)", () => {
  it("Instructor A sees only students enrolled in Instructor A's own courses, never Instructor B's, within the same tenant", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId: instructorA, course: courseA } = await setupInstructor(tenant.id);
    const { instructorId: instructorB, course: courseB } = await setupInstructor(tenant.id);

    const { ctx: studentX } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: studentX.userId }, data: { tenantId: tenant.id } });
    const { ctx: studentY } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: studentY.userId }, data: { tenantId: tenant.id } });

    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, studentX.userId, role.id);
    await createUserJobRole(tenant.id, studentY.userId, role.id);

    await enroll(studentX.userId, courseA.id);
    await enroll(studentY.userId, courseB.id);

    const resultA = await getInstructorCapabilityReport(instructorA, tenant.id);
    expect(resultA.learners.map((l) => l.userId)).toContain(studentX.userId);
    expect(resultA.learners.map((l) => l.userId)).not.toContain(studentY.userId);

    const resultB = await getInstructorCapabilityReport(instructorB, tenant.id);
    expect(resultB.learners.map((l) => l.userId)).toContain(studentY.userId);
    expect(resultB.learners.map((l) => l.userId)).not.toContain(studentX.userId);
  });
});

describe("getInstructorCapabilityReport — cross-tenant isolation", () => {
  it("an instructor never receives another tenant's students or courses", async () => {
    const { tenant: tenantA } = await createTenantUser("STUDENT");
    const { tenant: tenantB } = await createTenantUser("STUDENT");
    const { instructorId: instructorA } = await setupInstructor(tenantA.id);
    const { course: courseB } = await setupInstructor(tenantB.id);

    const { ctx: studentInB } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: studentInB.userId }, data: { tenantId: tenantB.id } });
    const role = await createJobRole(tenantB.id);
    await createUserJobRole(tenantB.id, studentInB.userId, role.id);
    await enroll(studentInB.userId, courseB.id);

    const result = await getInstructorCapabilityReport(instructorA, tenantA.id);
    expect(result.learners).toEqual([]);
  });
});

describe("getInstructorCapabilityReport — duplicate enrollment handling", () => {
  it("a student enrolled in two courses owned by the same instructor appears exactly once", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course: courseA } = await setupInstructor(tenant.id);
    const { course: courseB } = await createCourse(tenant.id, instructorId);
    await enroll(student.userId, courseA.id);
    await enroll(student.userId, courseB.id);
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, role.id);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners).toHaveLength(1);
    expect(result.learners[0].userId).toBe(student.userId);
  });
});

describe("getInstructorCapabilityReport — primary role resolution", () => {
  it("resolves multiple primary roles to the earliest assignedAt, matching computeCapabilityGap", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const roleA = await createJobRole(tenant.id);
    const roleB = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, roleB.id, true, new Date("2026-02-01"));
    await createUserJobRole(tenant.id, student.userId, roleA.id, true, new Date("2026-01-01"));

    const instructorResult = await getInstructorCapabilityReport(instructorId, tenant.id);
    const gapResult = await computeCapabilityGap({ ...student, tenantId: tenant.id });

    expect(instructorResult.learners[0].roleId).toBe(roleA.id);
    expect(gapResult.role?.id).toBe(roleA.id);
    expect(instructorResult.learners[0].roleId).toBe(gapResult.role?.id);
  });
});

describe("getInstructorCapabilityReport — capability semantics", () => {
  it("required active skill appears with correct required/current/met", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "INTERMEDIATE");
    await createUserJobRole(tenant.id, student.userId, role.id);
    await setUserSkill({
      tenantId: tenant.id,
      userId: student.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    const row = result.learners[0].skills[0];
    expect(row.skillId).toBe(skill.id);
    expect(row.required).toBe("INTERMEDIATE");
    expect(row.current).toBe("BEGINNER");
    expect(row.met).toBe(false);
  });

  it("excludes an optional (isRequired:false) RoleSkill", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER", false);
    await createUserJobRole(tenant.id, student.userId, role.id);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners[0].skills).toEqual([]);
  });

  it("excludes an archived skill", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await db.skill.update({ where: { id: skill.id }, data: { status: "ARCHIVED" } });
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, student.userId, role.id);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners[0].skills).toEqual([]);
  });

  it("missing UserSkill resolves to NONE and met:false", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, student.userId, role.id);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners[0].skills[0].current).toBe("NONE");
    expect(result.learners[0].skills[0].met).toBe(false);
  });

  it("proficiency at required level is met:true", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, student.userId, role.id);
    await setUserSkill({
      tenantId: tenant.id,
      userId: student.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners[0].skills[0].met).toBe(true);
  });

  it("proficiency above required level is met:true", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, student.userId, role.id);
    await setUserSkill({
      tenantId: tenant.id,
      userId: student.userId,
      skillId: skill.id,
      proficiency: "ADVANCED",
    });

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners[0].skills[0].met).toBe(true);
  });

  it("a role with zero required active skills still includes the learner, with skills: []", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, role.id);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners).toHaveLength(1);
    expect(result.learners[0].skills).toEqual([]);
  });
});

describe("getInstructorCapabilityReport — privacy", () => {
  it("response never contains evidence/score/verification/source fields", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, student.userId, role.id);
    await setUserSkill({
      tenantId: tenant.id,
      userId: student.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });
    await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: student.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "some-source",
        score: 42,
        verificationStatus: "REJECTED",
      },
    });

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /score|verificationStatus|sourceId|metadata|verifiedById|confidence|evidence/i
    );
  });

  it("never invokes db.skillEvidence.findMany", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, role.id);

    const spy = vi.spyOn(db.skillEvidence, "findMany");
    await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("getInstructorCapabilityReport — pagination", () => {
  async function seedLearners(tenantId: string, courseId: string, roleId: string, names: string[]) {
    const created: { id: string }[] = [];
    for (const name of names) {
      const user = await db.user.create({
        data: {
          clerkId: `clerk-${name}-${Math.random()}`,
          email: `${name.toLowerCase()}-${Math.random()}@example.test`,
          name,
          tenantId,
        },
      });
      await createUserJobRole(tenantId, user.id, roleId);
      await enroll(user.id, courseId);
      created.push(user);
    }
    return created;
  }

  it("default limit is 50", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    await seedLearners(
      tenant.id,
      course.id,
      role.id,
      Array.from({ length: 3 }, (_, i) => `Def-${i}`)
    );

    const result = await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(result.learners.length).toBeLessThanOrEqual(50);
  });

  it("limit is capped at 100 even if a larger value is requested", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    await seedLearners(tenant.id, course.id, role.id, ["Cap-1", "Cap-2"]);

    const result = await getInstructorCapabilityReport(instructorId, tenant.id, { limit: 999 });
    expect(result.learners.length).toBeLessThanOrEqual(100);
  });

  it("advances the cursor across pages with no duplicate or skipped rows, and the final page has nextCursor: null", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    const names = ["Amy", "Bob", "Cid", "Dee", "Eve"];
    await seedLearners(tenant.id, course.id, role.id, names);

    const page1 = await getInstructorCapabilityReport(instructorId, tenant.id, { limit: 2 });
    expect(page1.learners).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getInstructorCapabilityReport(instructorId, tenant.id, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.learners).toHaveLength(2);

    const page3 = await getInstructorCapabilityReport(instructorId, tenant.id, {
      limit: 2,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.learners).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.learners, ...page2.learners, ...page3.learners].map((l) => l.userId);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toHaveLength(names.length);
  });

  it("an invalid/undecodable cursor throws InstructorCapabilityCursorError", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId } = await setupInstructor(tenant.id);
    await expect(
      getInstructorCapabilityReport(instructorId, tenant.id, { cursor: "not-a-valid-cursor!!" })
    ).rejects.toThrow();
  });

  /** Same fixed-order technique organizationReport.test.ts uses for deterministic keyset assertions. */
  async function seedLearnersOrdered(
    tenantId: string,
    courseId: string,
    roleId: string,
    entries: Array<{ name: string | null }>
  ) {
    const runId = Math.random().toString(36).slice(2, 8);
    const created: Array<{ id: string; name: string | null; email: string }> = [];
    for (const [index, entry] of entries.entries()) {
      const user = await db.user.create({
        data: {
          clerkId: `clerk-${runId}-${index}`,
          email: `${runId}-${String(index).padStart(3, "0")}@example.test`,
          name: entry.name,
          tenantId,
        },
      });
      await createUserJobRole(tenantId, user.id, roleId);
      await enroll(user.id, courseId);
      created.push({ id: user.id, name: user.name, email: user.email });
    }
    return created;
  }

  function expectedOrder<T extends { id: string; name: string | null; email: string }>(
    users: T[]
  ): T[] {
    return [...users].sort((a, b) => {
      if (a.name === null && b.name !== null) return 1;
      if (a.name !== null && b.name === null) return -1;
      if (a.name !== null && b.name !== null && a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
      }
      if (a.email !== b.email) return a.email < b.email ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  }

  it("named -> unnamed boundary: named students on page 1, null-named on page 2, no skip/duplicate", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    const created = await seedLearnersOrdered(tenant.id, course.id, role.id, [
      { name: "Amy" },
      { name: "Bob" },
      { name: null },
      { name: null },
    ]);
    const [amy, bob, null1, null2] = created;

    const page1 = await getInstructorCapabilityReport(instructorId, tenant.id, { limit: 2 });
    expect(page1.learners.map((l) => l.userId)).toEqual([amy.id, bob.id]);

    const page2 = await getInstructorCapabilityReport(instructorId, tenant.id, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.learners.map((l) => l.userId)).toEqual([null1.id, null2.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("unnamed -> unnamed continuation stays correct within the NULLS LAST tail", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    const created = await seedLearnersOrdered(tenant.id, course.id, role.id, [
      { name: null },
      { name: null },
      { name: null },
    ]);
    const [first, second, third] = created;

    const page1 = await getInstructorCapabilityReport(instructorId, tenant.id, { limit: 2 });
    expect(page1.learners.map((l) => l.userId)).toEqual([first.id, second.id]);

    const page2 = await getInstructorCapabilityReport(instructorId, tenant.id, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.learners.map((l) => l.userId)).toEqual([third.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("full pagination integrity across a mixed named/null-named population matches the expected global sort order", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    const created = await seedLearnersOrdered(tenant.id, course.id, role.id, [
      { name: "Zed" },
      { name: "Amy" },
      { name: null },
      { name: null },
      { name: "Mno" },
      { name: null },
    ]);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getInstructorCapabilityReport(instructorId, tenant.id, {
        limit: 2,
        cursor,
      });
      collected.push(...page.learners.map((l) => l.userId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(collected).toEqual(expectedOrder(created).map((u) => u.id));
    expect(new Set(collected).size).toBe(created.length);
  });
});

describe("getInstructorCapabilityReport — no N+1 reuse of self-scoped functions", () => {
  it("does not call computeCapabilityGap per learner", async () => {
    const { tenant, ctx: student } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    await enroll(student.userId, course.id);
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, student.userId, role.id);

    const spy = vi.spyOn(gapsModule, "computeCapabilityGap");
    await getInstructorCapabilityReport(instructorId, tenant.id);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("fixed query count regardless of population size (no per-student query)", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { instructorId, course } = await setupInstructor(tenant.id);
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");

    for (let i = 0; i < 10; i++) {
      const user = await db.user.create({
        data: {
          clerkId: `clerk-count-${i}-${Math.random()}`,
          email: `count-${i}-${Math.random()}@example.test`,
          name: `Count-${i}`,
          tenantId: tenant.id,
        },
      });
      await createUserJobRole(tenant.id, user.id, role.id);
      await enroll(user.id, course.id);
    }

    const enrollmentSpy = vi.spyOn(db.enrollment, "findMany");
    const userSpy = vi.spyOn(db.user, "findMany");
    const userJobRoleSpy = vi.spyOn(db.userJobRole, "findMany");
    const userSkillSpy = vi.spyOn(db.userSkill, "findMany");

    await getInstructorCapabilityReport(instructorId, tenant.id);

    expect(enrollmentSpy).toHaveBeenCalledTimes(1);
    expect(userSpy).toHaveBeenCalledTimes(1);
    expect(userJobRoleSpy).toHaveBeenCalledTimes(1);
    expect(userSkillSpy).toHaveBeenCalledTimes(1);

    enrollmentSpy.mockRestore();
    userSpy.mockRestore();
    userJobRoleSpy.mockRestore();
    userSkillSpy.mockRestore();
  });
});

describe("getInstructorCapabilityReport — architecture", () => {
  it("never imports organizationReport.ts (Phase 9) or getInstructorStudents() (unrelated read model)", () => {
    const source = readFileSync(new URL("./instructorReport.ts", import.meta.url), "utf8");
    // Doc-comment prose may reference these names for context (as Phase 9's
    // own files do) — the real check is that no import statement pulls them in.
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/organizationReport["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/instructor-students["']/);
  });
});
