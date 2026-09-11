import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSkill } from "@/lib/domain/capability/__test__/fixtures";
import { listActiveSkills } from "@/lib/domain/capability/skillListing";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

describe("listActiveSkills — tenant/status matrix", () => {
  it("empty tenant -> empty result", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    const result = await listActiveSkills({ tenantId: tenant.id });
    expect(result).toEqual([]);
  });

  it("an ACTIVE skill is included", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    const skill = await createSkill(tenant.id, "Negotiation");

    const result = await listActiveSkills({ tenantId: tenant.id });
    expect(result).toEqual([
      { id: skill.id, name: skill.name, categoryId: null, categoryName: null },
    ]);
  });

  it("an ARCHIVED skill is excluded", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    await db.skill.create({
      data: {
        tenantId: tenant.id,
        name: "Old skill",
        slug: `old-${Date.now()}`,
        status: "ARCHIVED",
      },
    });

    const result = await listActiveSkills({ tenantId: tenant.id });
    expect(result).toEqual([]);
  });

  it("another tenant's skill never appears", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser("INSTRUCTOR");
    await createSkill(otherTenant.id, "Other tenant skill");

    const result = await listActiveSkills({ tenantId: tenant.id });
    expect(result).toEqual([]);
  });

  it("includes category name when the skill has a category", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    const category = await db.skillCategory.create({
      data: { tenantId: tenant.id, name: "Sales", slug: `sales-${Date.now()}` },
    });
    const skill = await db.skill.create({
      data: {
        tenantId: tenant.id,
        name: "Lead qualification",
        slug: `lead-qual-${Date.now()}`,
        categoryId: category.id,
      },
    });

    const result = await listActiveSkills({ tenantId: tenant.id });
    expect(result).toEqual([
      { id: skill.id, name: skill.name, categoryId: category.id, categoryName: category.name },
    ]);
  });

  it("orders by name ascending", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    await createSkill(tenant.id, "Zebra skill");
    await createSkill(tenant.id, "Alpha skill");

    const result = await listActiveSkills({ tenantId: tenant.id });
    expect(result.map((s) => s.name)).toEqual(["Alpha skill", "Zebra skill"]);
  });
});
