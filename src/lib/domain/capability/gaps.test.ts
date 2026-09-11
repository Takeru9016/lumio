import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createJobRole,
  createRoleSkill,
  createSkill,
  createUserJobRole,
} from "@/lib/domain/capability/__test__/fixtures";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
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
});
