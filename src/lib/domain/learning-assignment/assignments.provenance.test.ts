import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
import {
  addSkillToRole,
  assignRole,
  createCourseIn,
  createMandatoryTraining,
  createRoleWithSkill,
  createScenario,
  createTeamWithMember,
  createTenant,
  createUserIn,
  mapCourseToSkill,
  setUserSkill,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  createCapabilityGapAssignment,
  createMandatoryAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

afterAll(async () => {
  await db.$disconnect();
});

describe("MANUAL provenance", () => {
  it("records who assigned it, their name and a trimmed note", async () => {
    const { admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      note: "  Please finish before the audit.  ",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.reason).toEqual({
      assignedById: admin.user.id,
      assignedByName: admin.user.name,
      note: "Please finish before the audit.",
    });
  });

  it("omits the note when none (or only whitespace) is given", async () => {
    const { admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      note: "   ",
    });

    expect(result.ok && result.assignment.reason).toEqual({
      assignedById: admin.user.id,
      assignedByName: admin.user.name,
    });
  });

  it("ignores source, sourceKey, reason, tenantId and other fields a client tries to supply", async () => {
    const { tenant, admin, learner, course } = await createScenario();
    const otherTenant = await createTenant();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      source: "CAPABILITY_GAP",
      sourceKey: "gap:forged:forged",
      reason: { forged: true },
      tenantId: otherTenant.id,
      assignedById: "someone-else",
      mandatoryTrainingId: "forged",
      cancelledAt: new Date(),
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db.learningAssignment.findUniqueOrThrow({
      where: { id: result.assignment.id },
    });
    expect(row.source).toBe("MANUAL");
    expect(row.sourceKey).toBe(`manual:${course.id}`);
    expect(row.reason).toEqual({ assignedById: admin.user.id, assignedByName: admin.user.name });
    expect(row.tenantId).toBe(tenant.id);
    expect(row.assignedById).toBe(admin.user.id);
    expect(row.mandatoryTrainingId).toBeNull();
    expect(row.cancelledAt).toBeNull();
  });

  it("never rewrites the original provenance when the assignment is repeated", async () => {
    const { admin, learner, course } = await createScenario();
    const otherAdmin = await createUserIn(admin.ctx.tenantId, "ORG_ADMIN");

    const first = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      note: "original",
    });
    const second = await createManualAssignment(otherAdmin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      note: "changed",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.outcome).toBe("existing");
    const row = await db.learningAssignment.findUniqueOrThrow({
      where: { id: first.assignment.id },
    });
    expect(row.reason).toEqual({
      assignedById: admin.user.id,
      assignedByName: admin.user.name,
      note: "original",
    });
    expect(row.assignedById).toBe(admin.user.id);
  });
});

describe("MANDATORY provenance", () => {
  async function mandatoryScenario() {
    const scenario = await createScenario();
    const team = await createTeamWithMember(scenario.tenant.id, scenario.learner.user.id);
    const training = await createMandatoryTraining({
      tenantId: scenario.tenant.id,
      courseId: scenario.course.id,
      teamId: team.id,
    });
    return { ...scenario, team, training };
  }

  it("creates a MANDATORY assignment from the policy, with the policy's course and due date", async () => {
    const { tenant, admin, learner, course, team, training } = await mandatoryScenario();

    const result = await createMandatoryAssignment(admin.ctx, {
      userId: learner.user.id,
      mandatoryTrainingId: training.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("created");
    const row = await db.learningAssignment.findUniqueOrThrow({
      where: { id: result.assignment.id },
    });
    expect(row.source).toBe("MANDATORY");
    expect(row.sourceKey).toBe(`mandatory:${training.id}`);
    expect(row.mandatoryTrainingId).toBe(training.id);
    expect(row.tenantId).toBe(tenant.id);
    expect(row.courseId).toBe(course.id);
    expect(row.dueDate?.toISOString()).toBe(training.dueDate.toISOString());
    expect(row.reason).toEqual({
      mandatoryTrainingId: training.id,
      teamId: team.id,
      teamName: team.name,
      courseId: course.id,
      courseTitle: course.title,
    });
    expect(result.enrollment.status).toBe("ACTIVE");
    expect(result.notificationCreated).toBe(true);
  });

  it("is idempotent per learner and policy", async () => {
    const { learner, admin, training } = await mandatoryScenario();
    const input = { userId: learner.user.id, mandatoryTrainingId: training.id };

    const first = await createMandatoryAssignment(admin.ctx, input);
    const second = await createMandatoryAssignment(admin.ctx, input);

    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.outcome).toBe("existing");
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("does not touch the MandatoryTraining row (no counter change, no activation)", async () => {
    const { learner, admin, training } = await mandatoryScenario();

    await createMandatoryAssignment(admin.ctx, {
      userId: learner.user.id,
      mandatoryTrainingId: training.id,
    });

    const after = await db.mandatoryTraining.findUniqueOrThrow({ where: { id: training.id } });
    expect(after.completedCount).toBe(0);
    expect(after.activatedAt).toBeNull();
    expect(after.dueDate.toISOString()).toBe(training.dueDate.toISOString());
  });

  it("rejects a learner who is not a member of the policy's team", async () => {
    const { tenant, admin, training } = await mandatoryScenario();
    const outsider = await createUserIn(tenant.id, "STUDENT");

    const result = await createMandatoryAssignment(admin.ctx, {
      userId: outsider.user.id,
      mandatoryTrainingId: training.id,
    });

    expect(result).toEqual({ ok: false, reason: "LEARNER_NOT_IN_TEAM" });
    expect(await db.learningAssignment.count({ where: { userId: outsider.user.id } })).toBe(0);
    expect(await db.enrollment.count({ where: { userId: outsider.user.id } })).toBe(0);
  });

  it("rejects another tenant's policy without revealing it exists", async () => {
    const { training, learner } = await mandatoryScenario();
    const otherTenant = await createTenant();
    const otherAdmin = await createUserIn(otherTenant.id, "ORG_ADMIN");

    const result = await createMandatoryAssignment(otherAdmin.ctx, {
      userId: learner.user.id,
      mandatoryTrainingId: training.id,
    });
    const missing = await createMandatoryAssignment(otherAdmin.ctx, {
      userId: learner.user.id,
      mandatoryTrainingId: "does-not-exist",
    });

    expect(result).toEqual({ ok: false, reason: "MANDATORY_TRAINING_NOT_FOUND" });
    expect(missing).toEqual(result);
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(0);
  });

  it("does not let a client supply the course, due date or source", async () => {
    const { tenant, admin, learner, instructor, course, training } = await mandatoryScenario();
    const { course: otherCourse } = await createCourseIn(tenant.id, instructor.user.id);

    const result = await createMandatoryAssignment(admin.ctx, {
      userId: learner.user.id,
      mandatoryTrainingId: training.id,
      courseId: otherCourse.id,
      dueDate: new Date("2030-01-01T00:00:00.000Z"),
      source: "MANUAL",
      sourceKey: "manual:forged",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.courseId).toBe(course.id);
    expect(result.assignment.dueDate?.toISOString()).toBe(training.dueDate.toISOString());
    expect(result.assignment.source).toBe("MANDATORY");
    expect(result.assignment.sourceKey).toBe(`mandatory:${training.id}`);
  });

  it("applies the same enrollment rules: a paid course is rejected", async () => {
    const scenario = await createScenario();
    const { course: paid } = await createCourseIn(scenario.tenant.id, scenario.instructor.user.id, {
      price: 999,
    });
    const team = await createTeamWithMember(scenario.tenant.id, scenario.learner.user.id);
    const training = await createMandatoryTraining({
      tenantId: scenario.tenant.id,
      courseId: paid.id,
      teamId: team.id,
    });

    const result = await createMandatoryAssignment(scenario.admin.ctx, {
      userId: scenario.learner.user.id,
      mandatoryTrainingId: training.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_REQUIRES_PAYMENT" });
    expect(await db.enrollment.count({ where: { userId: scenario.learner.user.id } })).toBe(0);
  });
});

describe("CAPABILITY_GAP provenance", () => {
  async function gapScenario(
    options: {
      required?: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
      current?: "NONE" | "BEGINNER";
    } = {}
  ) {
    const scenario = await createScenario();
    const { role, skill } = await createRoleWithSkill({
      tenantId: scenario.tenant.id,
      requiredProficiency: options.required ?? "INTERMEDIATE",
    });
    await assignRole(scenario.tenant.id, scenario.learner.user.id, role.id);
    if (options.current) {
      await setUserSkill(scenario.tenant.id, scenario.learner.user.id, skill.id, options.current);
    }
    await mapCourseToSkill(scenario.course.id, skill.id);
    return { ...scenario, role, skill };
  }

  it("records the full gap context as an immutable snapshot", async () => {
    const { tenant, admin, learner, course, role, skill } = await gapScenario({
      required: "INTERMEDIATE",
      current: "BEGINNER",
    });

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db.learningAssignment.findUniqueOrThrow({
      where: { id: result.assignment.id },
    });
    expect(row.source).toBe("CAPABILITY_GAP");
    expect(row.sourceKey).toBe(`gap:${role.id}:${skill.id}`);
    expect(row.tenantId).toBe(tenant.id);
    expect(row.reason).toEqual({
      roleId: role.id,
      roleName: role.name,
      skillId: skill.id,
      skillName: skill.name,
      requiredProficiency: "INTERMEDIATE",
      currentProficiency: "BEGINNER",
      courseId: course.id,
      courseTitle: course.title,
    });
  });

  it("records NONE as the current proficiency when the learner has no skill row", async () => {
    const { admin, learner, course, role, skill } = await gapScenario();

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.reason).toMatchObject({ currentProficiency: "NONE" });
  });

  it("keeps two skill gaps closed by the same course as two separate assignments", async () => {
    const { tenant, admin, learner, course, role, skill } = await gapScenario();
    const secondSkill = await addSkillToRole(role.id, tenant.id, "ADVANCED");
    await mapCourseToSkill(course.id, secondSkill.id);

    const a = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: course.id,
    });
    const b = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: secondSkill.id,
      courseId: course.id,
    });

    expect(a.ok && a.outcome).toBe("created");
    expect(b.ok && b.outcome).toBe("created");
    const rows = await db.learningAssignment.findMany({
      where: { userId: learner.user.id, courseId: course.id },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.sourceKey)).size).toBe(2);
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("is idempotent for the same role, skill and course", async () => {
    const { admin, learner, course, role, skill } = await gapScenario();
    const input = {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: course.id,
    };

    await createCapabilityGapAssignment(admin.ctx, input);
    const again = await createCapabilityGapAssignment(admin.ctx, input);

    expect(again.ok && again.outcome).toBe("existing");
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("rejects a role the learner does not hold", async () => {
    const { tenant, admin, learner, course } = await gapScenario();
    const { role: otherRole, skill: otherSkill } = await createRoleWithSkill({
      tenantId: tenant.id,
    });
    await mapCourseToSkill(course.id, otherSkill.id);

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: otherRole.id,
      skillId: otherSkill.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "GAP_NOT_FOUND" });
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(0);
  });

  it("rejects a role from another tenant", async () => {
    const { admin, learner, course } = await gapScenario();
    const otherTenant = await createTenant();
    const { role: foreignRole, skill: foreignSkill } = await createRoleWithSkill({
      tenantId: otherTenant.id,
    });
    await assignRole(otherTenant.id, learner.user.id, foreignRole.id);

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: foreignRole.id,
      skillId: foreignSkill.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "GAP_NOT_FOUND" });
  });

  it("rejects a skill the role does not require", async () => {
    const { tenant, admin, learner, course, role } = await gapScenario();
    const { skill: unrelated } = await createRoleWithSkill({ tenantId: tenant.id });
    await mapCourseToSkill(course.id, unrelated.id);

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: unrelated.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "GAP_NOT_FOUND" });
  });

  it("rejects an archived skill", async () => {
    const scenario = await createScenario();
    const { role, skill } = await createRoleWithSkill({
      tenantId: scenario.tenant.id,
      skillStatus: "ARCHIVED",
    });
    await assignRole(scenario.tenant.id, scenario.learner.user.id, role.id);
    await mapCourseToSkill(scenario.course.id, skill.id);

    const result = await createCapabilityGapAssignment(scenario.admin.ctx, {
      userId: scenario.learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: scenario.course.id,
    });

    expect(result).toEqual({ ok: false, reason: "GAP_NOT_FOUND" });
  });

  it("rejects a gap the learner has already closed", async () => {
    const { tenant, admin, learner, course, role, skill } = await gapScenario();
    await setUserSkill(tenant.id, learner.user.id, skill.id, "ADVANCED");

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "GAP_ALREADY_MET" });
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(0);
  });

  it("rejects a course that is not mapped to the skill", async () => {
    const { tenant, admin, learner, instructor, role, skill } = await gapScenario();
    const { course: unmapped } = await createCourseIn(tenant.id, instructor.user.id);

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: unmapped.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_DOES_NOT_ADDRESS_SKILL" });
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(0);
  });

  it("rejects an open-catalogue course even when it is mapped to the skill", async () => {
    const { admin, learner, instructor, role, skill } = await gapScenario();
    const { course: catalogue } = await createCourseIn(null, instructor.user.id);
    await mapCourseToSkill(catalogue.id, skill.id);

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: catalogue.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_DOES_NOT_ADDRESS_SKILL" });
  });

  it("rejects another tenant's course", async () => {
    const { admin, learner, role, skill } = await gapScenario();
    const otherTenant = await createTenant();
    const otherInstructor = await createUserIn(otherTenant.id, "INSTRUCTOR");
    const { course: foreign } = await createCourseIn(otherTenant.id, otherInstructor.user.id);
    await mapCourseToSkill(foreign.id, skill.id);

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: foreign.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_NOT_FOUND" });
  });

  it("rejects a skill mapping that belongs to another tenant, even when a role requirement points at it", async () => {
    // RoleSkill has no tenant column of its own, and getRoleRequirements does
    // not check the skill's tenant. The management API prevents a role from
    // requiring another tenant's skill, but corrupt or legacy data could
    // contain one. The gap assignment's mapping query is the second line of
    // defence: it must not treat that foreign skill's mapping as valid.
    const { tenant, admin, learner, course, role } = await gapScenario();
    const otherTenant = await createTenant();
    const { skill: foreignSkill } = await createRoleWithSkill({ tenantId: otherTenant.id });
    await db.roleSkill.create({
      data: { roleId: role.id, skillId: foreignSkill.id, requiredProficiency: "INTERMEDIATE" },
    });
    await mapCourseToSkill(course.id, foreignSkill.id);

    // Precondition: the gap engine really does surface the foreign skill as an
    // unmet gap, so this test exercises the mapping query and not an earlier check.
    const { gaps } = await computeCapabilityGap({ ...learner.ctx, tenantId: tenant.id }, role.id);
    expect(gaps.find((g) => g.skillId === foreignSkill.id)?.met).toBe(false);

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: foreignSkill.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_DOES_NOT_ADDRESS_SKILL" });
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(0);
  });

  it("ignores client-supplied provenance and proficiency claims", async () => {
    const { admin, learner, course, role, skill } = await gapScenario({
      required: "ADVANCED",
      current: "BEGINNER",
    });

    const result = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: course.id,
      source: "MANUAL",
      sourceKey: "manual:forged",
      reason: { forged: true },
      requiredProficiency: "BEGINNER",
      currentProficiency: "EXPERT",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.source).toBe("CAPABILITY_GAP");
    expect(result.assignment.sourceKey).toBe(`gap:${role.id}:${skill.id}`);
    expect(result.assignment.reason).toMatchObject({
      requiredProficiency: "ADVANCED",
      currentProficiency: "BEGINNER",
    });
  });
});

describe("independent sources", () => {
  it("keeps manual, mandatory and capability-gap assignments for one course as three rows", async () => {
    const scenario = await createScenario();
    const { admin, learner, course, tenant } = scenario;
    const team = await createTeamWithMember(tenant.id, learner.user.id);
    const training = await createMandatoryTraining({
      tenantId: tenant.id,
      courseId: course.id,
      teamId: team.id,
    });
    const { role, skill } = await createRoleWithSkill({ tenantId: tenant.id });
    await assignRole(tenant.id, learner.user.id, role.id);
    await mapCourseToSkill(course.id, skill.id);

    const manual = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });
    const mandatory = await createMandatoryAssignment(admin.ctx, {
      userId: learner.user.id,
      mandatoryTrainingId: training.id,
    });
    const gap = await createCapabilityGapAssignment(admin.ctx, {
      userId: learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: course.id,
    });

    expect([manual, mandatory, gap].every((r) => r.ok && r.outcome === "created")).toBe(true);
    const rows = await db.learningAssignment.findMany({
      where: { userId: learner.user.id, courseId: course.id },
      orderBy: { source: "asc" },
    });
    expect(rows.map((r) => r.source).sort()).toEqual(["CAPABILITY_GAP", "MANDATORY", "MANUAL"]);
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(1);
    // One learner-facing announcement per assignment, each with its own key.
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(3);
  });
});
