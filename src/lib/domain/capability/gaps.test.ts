import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createJobRole,
  createRoleSkill,
  createSkill,
  createUserJobRole,
} from "@/lib/domain/capability/__test__/fixtures";
import { computeCapabilityGap, getUserAssignedRoles } from "@/lib/domain/capability/gaps";
import { getRecommendedLearning } from "@/lib/domain/capability/recommendations";
import { verifyEvidence } from "@/lib/domain/capability/verification";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

describe("computeCapabilityGap", () => {
  it("missing UserSkill is treated as NONE, producing a gap against a BEGINNER requirement", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.role?.id).toBe(role.id);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].currentProficiency).toBe("NONE");
    expect(result.gaps[0].met).toBe(false);
  });

  it("required BEGINNER + actual BEGINNER is met", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "BEGINNER" },
    });

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.gaps[0].met).toBe(true);
  });

  it("required INTERMEDIATE + actual BEGINNER is a gap", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "INTERMEDIATE");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "BEGINNER" },
    });

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.gaps[0].met).toBe(false);
  });

  it("required INTERMEDIATE + actual INTERMEDIATE is met", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "INTERMEDIATE");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        proficiency: "INTERMEDIATE",
      },
    });

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.gaps[0].met).toBe(true);
  });

  it("excludes RoleSkill rows where isRequired is false", async () => {
    const { tenant, ctx } = await createTenantUser();
    const requiredSkill = await createSkill(tenant.id);
    const optionalSkill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, requiredSkill.id, "BEGINNER", true);
    await createRoleSkill(role.id, optionalSkill.id, "BEGINNER", false);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].skillId).toBe(requiredSkill.id);
  });

  it("excludes archived Skills", async () => {
    const { tenant, ctx } = await createTenantUser();
    const activeSkill = await createSkill(tenant.id);
    const archivedSkill = await createSkill(tenant.id);
    await db.skill.update({ where: { id: archivedSkill.id }, data: { status: "ARCHIVED" } });
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, activeSkill.id, "BEGINNER");
    await createRoleSkill(role.id, archivedSkill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].skillId).toBe(activeSkill.id);
  });

  it("returns an empty result, not an error, when the user has no primary role", async () => {
    const { tenant, ctx } = await createTenantUser();
    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.role).toBeNull();
    expect(result.gaps).toEqual([]);
  });

  it("when multiple UserJobRole rows are isPrimary due to bad data, selects the earliest assignedAt deterministically", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skillOld = await createSkill(tenant.id);
    const skillNew = await createSkill(tenant.id);
    const roleOld = await createJobRole(tenant.id);
    const roleNew = await createJobRole(tenant.id);
    await createRoleSkill(roleOld.id, skillOld.id, "BEGINNER");
    await createRoleSkill(roleNew.id, skillNew.id, "BEGINNER");
    // Both rows are (invalidly) isPrimary: true — roleOld assigned first.
    await createUserJobRole(
      tenant.id,
      ctx.userId,
      roleOld.id,
      true,
      new Date("2026-01-01T00:00:00Z")
    );
    await createUserJobRole(
      tenant.id,
      ctx.userId,
      roleNew.id,
      true,
      new Date("2026-06-01T00:00:00Z")
    );

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
    expect(result.role?.id).toBe(roleOld.id);
    expect(result.gaps[0].skillId).toBe(skillOld.id);
  });

  it("computes against an explicit secondary (non-primary) role when roleId is given", async () => {
    const { tenant, ctx } = await createTenantUser();
    const primarySkill = await createSkill(tenant.id);
    const secondarySkill = await createSkill(tenant.id);
    const primaryRole = await createJobRole(tenant.id);
    const secondaryRole = await createJobRole(tenant.id);
    await createRoleSkill(primaryRole.id, primarySkill.id, "BEGINNER");
    await createRoleSkill(secondaryRole.id, secondarySkill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, primaryRole.id, true);
    await createUserJobRole(tenant.id, ctx.userId, secondaryRole.id, false);

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id }, secondaryRole.id);
    expect(result.role?.id).toBe(secondaryRole.id);
    expect(result.gaps[0].skillId).toBe(secondarySkill.id);
  });

  it("cannot resolve a roleId belonging to another tenant", async () => {
    const { tenant, ctx } = await createTenantUser();
    const { tenant: otherTenant } = await createTenantUser();
    const otherRole = await createJobRole(otherTenant.id);

    const result = await computeCapabilityGap({ ...ctx, tenantId: tenant.id }, otherRole.id);
    expect(result.role).toBeNull();
    expect(result.gaps).toEqual([]);
  });

  describe("Phase 21 — multi-role gap scoping", () => {
    it("the same skill produces a different gap outcome for each role a user holds", async () => {
      const { tenant, ctx } = await createTenantUser();
      const sharedSkill = await createSkill(tenant.id);
      const roleAOnlySkill = await createSkill(tenant.id);
      const roleBOnlySkill = await createSkill(tenant.id);
      const roleA = await createJobRole(tenant.id);
      const roleB = await createJobRole(tenant.id);

      // Role A: sharedSkill requires ADVANCED, plus a role-A-only skill.
      await createRoleSkill(roleA.id, sharedSkill.id, "ADVANCED");
      await createRoleSkill(roleA.id, roleAOnlySkill.id, "INTERMEDIATE");
      // Role B: same sharedSkill requires only INTERMEDIATE, plus a role-B-only skill.
      await createRoleSkill(roleB.id, sharedSkill.id, "INTERMEDIATE");
      await createRoleSkill(roleB.id, roleBOnlySkill.id, "BEGINNER");

      await createUserJobRole(tenant.id, ctx.userId, roleA.id, true);
      await createUserJobRole(tenant.id, ctx.userId, roleB.id, false);

      // One UserSkill row — the "same UserSkill satisfies one role but not
      // another" requirement — INTERMEDIATE meets Role B's requirement but
      // falls short of Role A's ADVANCED requirement.
      await db.userSkill.create({
        data: {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: sharedSkill.id,
          proficiency: "INTERMEDIATE",
        },
      });

      const resultA = await computeCapabilityGap({ ...ctx, tenantId: tenant.id }, roleA.id);
      const resultB = await computeCapabilityGap({ ...ctx, tenantId: tenant.id }, roleB.id);

      expect(resultA.gaps).toHaveLength(2);
      const sharedInA = resultA.gaps.find((g) => g.skillId === sharedSkill.id);
      expect(sharedInA?.requiredProficiency).toBe("ADVANCED");
      expect(sharedInA?.currentProficiency).toBe("INTERMEDIATE");
      expect(sharedInA?.met).toBe(false);
      // Role A's gaps never include Role B's exclusive skill.
      expect(resultA.gaps.some((g) => g.skillId === roleBOnlySkill.id)).toBe(false);

      expect(resultB.gaps).toHaveLength(2);
      const sharedInB = resultB.gaps.find((g) => g.skillId === sharedSkill.id);
      expect(sharedInB?.requiredProficiency).toBe("INTERMEDIATE");
      expect(sharedInB?.currentProficiency).toBe("INTERMEDIATE");
      expect(sharedInB?.met).toBe(true);
      // Role B's gaps never include Role A's exclusive skill.
      expect(resultB.gaps.some((g) => g.skillId === roleAOnlySkill.id)).toBe(false);
    });

    it("a single-role user's explicit-roleId result is identical to their default (primary) result", async () => {
      const { tenant, ctx } = await createTenantUser();
      const skill = await createSkill(tenant.id);
      const role = await createJobRole(tenant.id);
      await createRoleSkill(role.id, skill.id, "INTERMEDIATE");
      await createUserJobRole(tenant.id, ctx.userId, role.id, true);
      await db.userSkill.create({
        data: {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          proficiency: "BEGINNER",
        },
      });

      const defaultResult = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });
      const explicitResult = await computeCapabilityGap({ ...ctx, tenantId: tenant.id }, role.id);
      expect(explicitResult).toEqual(defaultResult);
    });
  });

  describe("getUserAssignedRoles", () => {
    it("returns every role the user holds, primary first", async () => {
      const { tenant, ctx } = await createTenantUser();
      const roleA = await createJobRole(tenant.id, "Role A");
      const roleB = await createJobRole(tenant.id, "Role B");
      await createUserJobRole(tenant.id, ctx.userId, roleA.id, true);
      await createUserJobRole(tenant.id, ctx.userId, roleB.id, false);

      const roles = await getUserAssignedRoles({ ...ctx, tenantId: tenant.id });
      expect(roles).toHaveLength(2);
      expect(roles[0]).toMatchObject({ roleId: roleA.id, roleName: "Role A", isPrimary: true });
      expect(roles.some((r) => r.roleId === roleB.id && r.isPrimary === false)).toBe(true);
    });

    it("returns an empty array, not an error, for a user with no roles", async () => {
      const { tenant, ctx } = await createTenantUser();
      const roles = await getUserAssignedRoles({ ...ctx, tenantId: tenant.id });
      expect(roles).toEqual([]);
    });

    it("never returns another user's roles", async () => {
      const { tenant, ctx } = await createTenantUser();
      const { ctx: otherCtx } = await createTenantUser();
      const role = await createJobRole(tenant.id);
      await createUserJobRole(tenant.id, otherCtx.userId, role.id, true);

      const roles = await getUserAssignedRoles({ ...ctx, tenantId: tenant.id });
      expect(roles).toEqual([]);
    });
  });
});

/**
 * The central Phase 21 regression test (per the locked contract's "Important
 * Integration Test") — real DB, no mocks, walking the full chain: tenant ->
 * two roles with a shared-but-differently-required skill and a role-
 * exclusive skill each -> both roles assigned to one learner -> real
 * evidence created and verified through verifyEvidence (not a raw UserSkill
 * insert) -> Role A gaps vs Role B gaps diverge for the shared skill ->
 * Role A recommendations vs Role B recommendations diverge for the
 * role-exclusive skills.
 */
describe("Phase 21 — end-to-end multi-role integration", () => {
  it("evidence -> verification -> UserSkill projection composes correctly with role-scoped gaps and recommendations", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");

    const roleA = await createJobRole(tenant.id, "Engineer");
    const roleB = await createJobRole(tenant.id, "Team Lead");
    const sharedSkill = await createSkill(tenant.id);
    const roleAOnlySkill = await createSkill(tenant.id);
    const roleBOnlySkill = await createSkill(tenant.id);

    // Role A needs the shared skill at ADVANCED; Role B needs it only at
    // INTERMEDIATE. Each role also has one skill exclusive to it.
    await createRoleSkill(roleA.id, sharedSkill.id, "ADVANCED");
    await createRoleSkill(roleA.id, roleAOnlySkill.id, "INTERMEDIATE");
    await createRoleSkill(roleB.id, sharedSkill.id, "INTERMEDIATE");
    await createRoleSkill(roleB.id, roleBOnlySkill.id, "BEGINNER");

    await createUserJobRole(tenant.id, learnerCtx.userId, roleA.id, true);
    await createUserJobRole(tenant.id, learnerCtx.userId, roleB.id, false);

    // Real evidence, on a real enrolled course, verified through the real
    // verifyEvidence function — never a raw db.userSkill.create shortcut.
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: course.id, status: "ACTIVE" },
    });
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: sharedSkill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: course.id,
      },
    });
    const projectedSkill = await verifyEvidence(
      { ...instructorCtx, tenantId: tenant.id },
      evidence.id
    );
    // VERIFIED evidence ceilings to INTERMEDIATE (Phase 5 policy, unchanged).
    expect(projectedSkill.proficiency).toBe("INTERMEDIATE");

    const gapsA = await computeCapabilityGap({ ...learnerCtx, tenantId: tenant.id }, roleA.id);
    const gapsB = await computeCapabilityGap({ ...learnerCtx, tenantId: tenant.id }, roleB.id);

    // Role A: INTERMEDIATE < ADVANCED required -> still a gap.
    const sharedInA = gapsA.gaps.find((g) => g.skillId === sharedSkill.id);
    expect(sharedInA?.met).toBe(false);
    // Role B: INTERMEDIATE meets its own INTERMEDIATE requirement -> met.
    const sharedInB = gapsB.gaps.find((g) => g.skillId === sharedSkill.id);
    expect(sharedInB?.met).toBe(true);

    const { course: courseForRoleAOnly } = await createCourse(tenant.id, instructorCtx.userId);
    await db.courseSkill.create({
      data: { courseId: courseForRoleAOnly.id, skillId: roleAOnlySkill.id },
    });
    await db.course.update({ where: { id: courseForRoleAOnly.id }, data: { status: "PUBLISHED" } });
    const { course: courseForRoleBOnly } = await createCourse(tenant.id, instructorCtx.userId);
    await db.courseSkill.create({
      data: { courseId: courseForRoleBOnly.id, skillId: roleBOnlySkill.id },
    });
    await db.course.update({ where: { id: courseForRoleBOnly.id }, data: { status: "PUBLISHED" } });

    const recsA = await getRecommendedLearning({ ...learnerCtx, tenantId: tenant.id }, roleA.id);
    const recsB = await getRecommendedLearning({ ...learnerCtx, tenantId: tenant.id }, roleB.id);

    // Role A's recommendations correspond to Role A's own unmet gaps only —
    // the role-B-only course never appears, and vice versa.
    expect(recsA.recommendations.map((r) => r.courseId)).toContain(courseForRoleAOnly.id);
    expect(recsA.recommendations.map((r) => r.courseId)).not.toContain(courseForRoleBOnly.id);
    expect(recsB.recommendations.map((r) => r.courseId)).toContain(courseForRoleBOnly.id);
    expect(recsB.recommendations.map((r) => r.courseId)).not.toContain(courseForRoleAOnly.id);
  });
});
