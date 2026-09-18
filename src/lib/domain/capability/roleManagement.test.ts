import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createJobRole as createJobRoleFixture,
  createRoleSkill,
  createSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";
import {
  addRoleSkill,
  assignUserJobRole,
  changePrimaryUserJobRole,
  createJobRole,
  createSkillMinimal,
  deleteJobRole,
  getJobRoleDetail,
  listJobRoles,
  removeRoleSkill,
  removeUserJobRole,
  updateJobRole,
  updateRoleSkill,
} from "@/lib/domain/capability/roleManagement";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function ctxFor(role: "ORG_ADMIN" | "STUDENT" | "INSTRUCTOR" | "SUPER_ADMIN" = "ORG_ADMIN") {
  const { tenant, ctx } = await createTenantUser(role);
  return { tenant, ctx: { ...ctx, tenantId: tenant.id } };
}

async function otherTenantCtx() {
  const { tenant, ctx } = await createTenantUser("ORG_ADMIN");
  return { tenant, ctx: { ...ctx, tenantId: tenant.id } };
}

describe("JobRole", () => {
  it("creates a role with a server-derived slug", async () => {
    const { ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "Frontend Engineer" });
    expect(role.name).toBe("Frontend Engineer");
    const stored = await db.jobRole.findUniqueOrThrow({ where: { id: role.id } });
    expect(stored.slug).toBe("frontend-engineer");
    expect(stored.tenantId).toBe(ctx.tenantId);
  });

  it("rejects an empty name", async () => {
    const { ctx } = await ctxFor();
    await expect(createJobRole(ctx, { name: "  " })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a name over 100 characters", async () => {
    const { ctx } = await ctxFor();
    await expect(createJobRole(ctx, { name: "x".repeat(101) })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects a case-insensitive duplicate name within the tenant", async () => {
    const { ctx } = await ctxFor();
    await createJobRole(ctx, { name: "Backend Engineer" });
    await expect(createJobRole(ctx, { name: "backend engineer" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("allows the same name in a different tenant", async () => {
    const { ctx } = await ctxFor();
    const { ctx: otherCtx } = await otherTenantCtx();
    await createJobRole(ctx, { name: "Designer" });
    await expect(createJobRole(otherCtx, { name: "Designer" })).resolves.toBeDefined();
  });

  it("lists roles for the tenant only, with skill/user counts", async () => {
    const { ctx } = await ctxFor();
    const { ctx: otherCtx } = await otherTenantCtx();
    await createJobRole(ctx, { name: "Role A" });
    await createJobRole(otherCtx, { name: "Role B" });
    const roles = await listJobRoles(ctx);
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe("Role A");
    expect(roles[0].skillCount).toBe(0);
    expect(roles[0].assignedUserCount).toBe(0);
  });

  it("gets detail with roleSkills and assignedUsers", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkill(tenant.id);
    const role = await createJobRoleFixture(tenant.id);
    await createRoleSkill(role.id, skill.id, "INTERMEDIATE");
    const detail = await getJobRoleDetail(ctx, role.id);
    expect(detail.roleSkills).toHaveLength(1);
    expect(detail.roleSkills[0].requiredProficiency).toBe("INTERMEDIATE");
  });

  it("cross-tenant role detail -> 404", async () => {
    const { tenant } = await ctxFor();
    const { ctx: otherCtx } = await otherTenantCtx();
    const role = await createJobRoleFixture(tenant.id);
    await expect(getJobRoleDetail(otherCtx, role.id)).rejects.toMatchObject({ status: 404 });
  });

  it("updates name/description, revalidating constraints", async () => {
    const { ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "Old name" });
    const updated = await updateJobRole(ctx, role.id, { name: "New name", description: "desc" });
    expect(updated.name).toBe("New name");
    expect(updated.description).toBe("desc");
  });

  it("rename to an existing name -> 409", async () => {
    const { ctx } = await ctxFor();
    await createJobRole(ctx, { name: "Taken" });
    const role = await createJobRole(ctx, { name: "Original" });
    await expect(updateJobRole(ctx, role.id, { name: "taken" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("update cross-tenant/nonexistent -> 404", async () => {
    const { ctx: otherCtx } = await otherTenantCtx();
    await expect(updateJobRole(otherCtx, "nonexistent-id", { name: "X" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deletes an empty role", async () => {
    const { ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "Disposable" });
    await deleteJobRole(ctx, role.id);
    await expect(db.jobRole.findUnique({ where: { id: role.id } })).resolves.toBeNull();
  });

  it("refuses to delete a role with assigned users -> 409, and does not cascade", async () => {
    const { tenant, ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "Staffed" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });
    await assignUserJobRole(ctx, role.id, { userId: memberCtx.userId });

    await expect(deleteJobRole(ctx, role.id)).rejects.toMatchObject({ status: 409 });
    await expect(db.jobRole.findUnique({ where: { id: role.id } })).resolves.not.toBeNull();
  });

  it("deleting a role with only RoleSkill requirements succeeds and cascades them", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(ctx, { name: "SkillsOnly" });
    await addRoleSkill(ctx, role.id, { skillId: skill.id, requiredProficiency: "BEGINNER" });

    await deleteJobRole(ctx, role.id);
    await expect(db.roleSkill.findFirst({ where: { roleId: role.id } })).resolves.toBeNull();
  });
});

describe("Skill (minimal creation)", () => {
  it("creates a skill: categoryId null, status ACTIVE", async () => {
    const { ctx } = await ctxFor();
    const skill = await createSkillMinimal(ctx, { name: "React" });
    const stored = await db.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(stored.categoryId).toBeNull();
    expect(stored.status).toBe("ACTIVE");
    expect(stored.tenantId).toBe(ctx.tenantId);
  });

  it("rejects a duplicate case-insensitive name", async () => {
    const { ctx } = await ctxFor();
    await createSkillMinimal(ctx, { name: "TypeScript" });
    await expect(createSkillMinimal(ctx, { name: "typescript" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects an invalid name", async () => {
    const { ctx } = await ctxFor();
    await expect(createSkillMinimal(ctx, { name: "" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("RoleSkill", () => {
  it("adds a skill requirement", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(ctx, { name: "R1" });
    const rs = await addRoleSkill(ctx, role.id, {
      skillId: skill.id,
      requiredProficiency: "ADVANCED",
    });
    expect(rs.requiredProficiency).toBe("ADVANCED");
  });

  it("rejects a duplicate (roleId, skillId)", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(ctx, { name: "R1" });
    await addRoleSkill(ctx, role.id, { skillId: skill.id, requiredProficiency: "BEGINNER" });
    await expect(
      addRoleSkill(ctx, role.id, { skillId: skill.id, requiredProficiency: "ADVANCED" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an invalid skillId", async () => {
    const { ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "R1" });
    await expect(
      addRoleSkill(ctx, role.id, { skillId: "nonexistent", requiredProficiency: "BEGINNER" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a cross-tenant skillId", async () => {
    const { ctx } = await ctxFor();
    const { tenant: otherTenant } = await otherTenantCtx();
    const otherSkill = await createSkill(otherTenant.id);
    const role = await createJobRole(ctx, { name: "R1" });
    await expect(
      addRoleSkill(ctx, role.id, { skillId: otherSkill.id, requiredProficiency: "BEGINNER" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects NONE as a required proficiency", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(ctx, { name: "R1" });
    await expect(
      addRoleSkill(ctx, role.id, { skillId: skill.id, requiredProficiency: "NONE" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("updates requiredProficiency, and computeCapabilityGap reflects it on the next call", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkill(tenant.id);
    const role = await createJobRoleFixture(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await db.userJobRole.create({
      data: { tenantId: tenant.id, userId: ctx.userId, roleId: role.id, isPrimary: true },
    });

    const before = await computeCapabilityGap(ctx);
    expect(before.gaps[0].requiredProficiency).toBe("BEGINNER");

    await updateRoleSkill(ctx, role.id, skill.id, { requiredProficiency: "EXPERT" });

    const after = await computeCapabilityGap(ctx);
    expect(after.gaps[0].requiredProficiency).toBe("EXPERT");
  });

  it("removing a RoleSkill leaves SkillEvidence/UserSkill untouched", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(ctx, { name: "R1" });
    await addRoleSkill(ctx, role.id, { skillId: skill.id, requiredProficiency: "BEGINNER" });

    await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "QuizAttempt",
        sourceId: "fake-source",
        verificationStatus: "VERIFIED",
      },
    });
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );

    await removeRoleSkill(ctx, role.id, skill.id);

    await expect(
      db.roleSkill.findFirst({ where: { roleId: role.id, skillId: skill.id } })
    ).resolves.toBeNull();
    await expect(
      db.skillEvidence.findFirst({
        where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
      })
    ).resolves.not.toBeNull();
    await expect(
      db.userSkill.findUnique({
        where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
      })
    ).resolves.toMatchObject({ proficiency: "INTERMEDIATE" });
  });
});

describe("UserJobRole", () => {
  it("first assignment becomes primary", async () => {
    const { tenant, ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "R1" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });

    const assignment = await assignUserJobRole(ctx, role.id, { userId: memberCtx.userId });
    expect(assignment.isPrimary).toBe(true);
  });

  it("second assignment defaults non-primary", async () => {
    const { tenant, ctx } = await ctxFor();
    const roleA = await createJobRole(ctx, { name: "RA" });
    const roleB = await createJobRole(ctx, { name: "RB" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });

    await assignUserJobRole(ctx, roleA.id, { userId: memberCtx.userId });
    const second = await assignUserJobRole(ctx, roleB.id, { userId: memberCtx.userId });
    expect(second.isPrimary).toBe(false);
  });

  it("explicit primary promotion demotes the previous primary", async () => {
    const { tenant, ctx } = await ctxFor();
    const roleA = await createJobRole(ctx, { name: "RA" });
    const roleB = await createJobRole(ctx, { name: "RB" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });

    await assignUserJobRole(ctx, roleA.id, { userId: memberCtx.userId });
    await assignUserJobRole(ctx, roleB.id, { userId: memberCtx.userId, isPrimary: true });

    const rows = await db.userJobRole.findMany({
      where: { tenantId: tenant.id, userId: memberCtx.userId },
    });
    const primaryRows = rows.filter((r) => r.isPrimary);
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0].roleId).toBe(roleB.id);
  });

  it("changePrimaryUserJobRole demotes the previous primary and promotes the target", async () => {
    const { tenant, ctx } = await ctxFor();
    const roleA = await createJobRole(ctx, { name: "RA" });
    const roleB = await createJobRole(ctx, { name: "RB" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });

    await assignUserJobRole(ctx, roleA.id, { userId: memberCtx.userId });
    await assignUserJobRole(ctx, roleB.id, { userId: memberCtx.userId });

    await changePrimaryUserJobRole(ctx, roleB.id, memberCtx.userId);

    const rows = await db.userJobRole.findMany({
      where: { tenantId: tenant.id, userId: memberCtx.userId },
    });
    expect(rows.find((r) => r.roleId === roleA.id)?.isPrimary).toBe(false);
    expect(rows.find((r) => r.roleId === roleB.id)?.isPrimary).toBe(true);
  });

  it("rejects a duplicate assignment (P2002 -> 409)", async () => {
    const { tenant, ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "R1" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });

    await assignUserJobRole(ctx, role.id, { userId: memberCtx.userId });
    await expect(
      assignUserJobRole(ctx, role.id, { userId: memberCtx.userId })
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects a duplicate assignment even when isPrimary:true is requested — never silently promotes", async () => {
    const { tenant, ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "R1" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });

    await assignUserJobRole(ctx, role.id, { userId: memberCtx.userId });
    await expect(
      assignUserJobRole(ctx, role.id, { userId: memberCtx.userId, isPrimary: true })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an invalid userId", async () => {
    const { ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "R1" });
    await expect(assignUserJobRole(ctx, role.id, { userId: "nonexistent" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects a cross-tenant userId", async () => {
    const { ctx } = await ctxFor();
    const { ctx: otherMemberCtx } = await otherTenantCtx();
    const role = await createJobRole(ctx, { name: "R1" });
    await expect(
      assignUserJobRole(ctx, role.id, { userId: otherMemberCtx.userId })
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects a cross-tenant roleId", async () => {
    const { ctx } = await ctxFor();
    const { tenant: otherTenant, ctx: otherCtx } = await otherTenantCtx();
    const otherRole = await createJobRoleFixture(otherTenant.id);
    await expect(
      assignUserJobRole(ctx, otherRole.id, { userId: otherCtx.userId })
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects a soft-deleted user", async () => {
    const { tenant, ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "R1" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({
      where: { id: memberCtx.userId },
      data: { tenantId: tenant.id, deletedAt: new Date() },
    });

    await expect(
      assignUserJobRole(ctx, role.id, { userId: memberCtx.userId })
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("removes a non-primary assignment without affecting the primary", async () => {
    const { tenant, ctx } = await ctxFor();
    const roleA = await createJobRole(ctx, { name: "RA" });
    const roleB = await createJobRole(ctx, { name: "RB" });
    const { ctx: memberCtx } = await createTenantUser("STUDENT");
    await db.user.update({ where: { id: memberCtx.userId }, data: { tenantId: tenant.id } });

    await assignUserJobRole(ctx, roleA.id, { userId: memberCtx.userId });
    await assignUserJobRole(ctx, roleB.id, { userId: memberCtx.userId });

    await removeUserJobRole(ctx, roleB.id, memberCtx.userId);

    const remaining = await db.userJobRole.findMany({
      where: { tenantId: tenant.id, userId: memberCtx.userId },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].roleId).toBe(roleA.id);
    expect(remaining[0].isPrimary).toBe(true);
  });

  it("removing the only (primary) role leaves zero primary roles, no auto-promotion, and computeCapabilityGap becomes empty", async () => {
    const { tenant, ctx } = await ctxFor();
    const role = await createJobRole(ctx, { name: "R1" });
    await assignUserJobRole(ctx, role.id, { userId: ctx.userId });

    await removeUserJobRole(ctx, role.id, ctx.userId);

    const remaining = await db.userJobRole.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId },
    });
    expect(remaining).toHaveLength(0);

    const gap = await computeCapabilityGap(ctx);
    expect(gap).toEqual({ role: null, gaps: [] });
  });
});

describe("Downstream integration — computeCapabilityGap composes with unmodified engine", () => {
  it("required INTERMEDIATE, no evidence -> met:false, current NONE; real VERIFIED evidence -> met:true", async () => {
    const { tenant, ctx } = await ctxFor();
    const skill = await createSkillMinimal(ctx, { name: "React" });
    const role = await createJobRole(ctx, { name: "Frontend Engineer" });
    await addRoleSkill(ctx, role.id, { skillId: skill.id, requiredProficiency: "INTERMEDIATE" });
    await assignUserJobRole(ctx, role.id, { userId: ctx.userId });

    const before = await computeCapabilityGap(ctx);
    expect(before.role?.id).toBe(role.id);
    expect(before.gaps).toHaveLength(1);
    expect(before.gaps[0].requiredProficiency).toBe("INTERMEDIATE");
    expect(before.gaps[0].currentProficiency).toBe("NONE");
    expect(before.gaps[0].met).toBe(false);

    // Real evidence + projection path (verification.ts's own pattern) —
    // VERIFIED evidence ceilings at INTERMEDIATE (proficiency.ts's
    // ceilingFor), so this is the minimal real path to INTERMEDIATE without
    // needing a full instructor/verification actor for this test.
    await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "QuizAttempt",
        sourceId: "integration-test-source",
        verificationStatus: "VERIFIED",
      },
    });
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );

    const after = await computeCapabilityGap(ctx);
    expect(after.gaps[0].met).toBe(true);
  });
});
