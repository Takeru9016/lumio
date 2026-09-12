import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createJobRole,
  createRoleSkill,
  createSkill,
  createUserJobRole,
} from "@/lib/domain/capability/__test__/fixtures";
import * as gapsModule from "@/lib/domain/capability/gaps";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
import { getOrganizationCapabilityReport } from "@/lib/domain/capability/organizationReport";
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

describe("getOrganizationCapabilityReport — population", () => {
  it("includes a user with a primary role and required skills", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);

    expect(result.learners).toHaveLength(1);
    expect(result.learners[0].userId).toBe(ctx.userId);
    expect(result.learners[0].roleId).toBe(role.id);
  });

  it("excludes a user with no UserJobRole", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners).toEqual([]);
  });

  it("excludes a user whose UserJobRole rows are all isPrimary:false", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id, false);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners).toEqual([]);
  });

  it("includes an ORG_ADMIN user with a primary role (Role enum does not gate inclusion)", async () => {
    const { tenant, ctx } = await createTenantUser("ORG_ADMIN");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners.map((l) => l.userId)).toContain(ctx.userId);
  });

  it("includes an INSTRUCTOR user with a primary role", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners.map((l) => l.userId)).toContain(ctx.userId);
  });

  it("excludes a soft-deleted user", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await db.user.update({ where: { id: ctx.userId }, data: { deletedAt: new Date() } });

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners).toEqual([]);
  });

  it("another tenant's users never appear", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const { tenant: otherTenant, ctx: otherCtx } = await createTenantUser("STUDENT");
    const role = await createJobRole(otherTenant.id);
    await createUserJobRole(otherTenant.id, otherCtx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners).toEqual([]);
  });
});

describe("getOrganizationCapabilityReport — primary role resolution", () => {
  it("resolves multiple primary roles to the earliest assignedAt, matching computeCapabilityGap", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const roleA = await createJobRole(tenant.id);
    const roleB = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, roleB.id, true, new Date("2026-02-01"));
    await createUserJobRole(tenant.id, ctx.userId, roleA.id, true, new Date("2026-01-01"));

    const orgResult = await getOrganizationCapabilityReport(tenant.id);
    const gapResult = await computeCapabilityGap({ ...ctx, tenantId: tenant.id });

    expect(orgResult.learners[0].roleId).toBe(roleA.id);
    expect(gapResult.role?.id).toBe(roleA.id);
    expect(orgResult.learners[0].roleId).toBe(gapResult.role?.id);
  });
});

describe("getOrganizationCapabilityReport — capability semantics", () => {
  it("required active skill appears with correct required/current/met", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "INTERMEDIATE");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await setUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });

    const result = await getOrganizationCapabilityReport(tenant.id);
    const row = result.learners[0].skills[0];
    expect(row.skillId).toBe(skill.id);
    expect(row.required).toBe("INTERMEDIATE");
    expect(row.current).toBe("BEGINNER");
    expect(row.met).toBe(false);
  });

  it("excludes an optional (isRequired:false) RoleSkill", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER", false);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners[0].skills).toEqual([]);
  });

  it("excludes an archived skill", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await db.skill.update({ where: { id: skill.id }, data: { status: "ARCHIVED" } });
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners[0].skills).toEqual([]);
  });

  it("missing UserSkill resolves to NONE and met:false", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners[0].skills[0].current).toBe("NONE");
    expect(result.learners[0].skills[0].met).toBe(false);
  });

  it("sufficient proficiency is met:true", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await setUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "ADVANCED",
    });

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners[0].skills[0].met).toBe(true);
  });

  it("a role with zero required active skills still includes the learner, with skills: []", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners).toHaveLength(1);
    expect(result.learners[0].skills).toEqual([]);
  });
});

describe("getOrganizationCapabilityReport — privacy", () => {
  it("response never contains evidence/score/verification/source fields", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const skill = await createSkill(tenant.id);
    await createRoleSkill(role.id, skill.id, "BEGINNER");
    await createUserJobRole(tenant.id, ctx.userId, role.id);
    await setUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });
    await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "some-source",
        score: 42,
        verificationStatus: "REJECTED",
      },
    });

    const result = await getOrganizationCapabilityReport(tenant.id);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /score|verificationStatus|sourceId|metadata|verifiedById|confidence|evidence/i
    );
  });

  it("never invokes db.skillEvidence.findMany", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const spy = vi.spyOn(db.skillEvidence, "findMany");
    await getOrganizationCapabilityReport(tenant.id);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("getOrganizationCapabilityReport — pagination", () => {
  async function seedLearners(tenantId: string, roleId: string, names: string[]) {
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
      created.push(user);
    }
    return created;
  }

  it("default limit is 50", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await seedLearners(
      tenant.id,
      role.id,
      Array.from({ length: 3 }, (_, i) => `Def-${i}`)
    );

    const result = await getOrganizationCapabilityReport(tenant.id);
    expect(result.learners.length).toBeLessThanOrEqual(50);
  });

  it("limit is capped at 100 even if a larger value is requested", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await seedLearners(tenant.id, role.id, ["Cap-1", "Cap-2"]);

    const result = await getOrganizationCapabilityReport(tenant.id, { limit: 999 });
    expect(result.learners.length).toBeLessThanOrEqual(100);
  });

  it("advances the cursor across pages with no duplicate or skipped rows, and the final page has nextCursor: null", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const names = ["Amy", "Bob", "Cid", "Dee", "Eve"];
    await seedLearners(tenant.id, role.id, names);

    const page1 = await getOrganizationCapabilityReport(tenant.id, { limit: 2 });
    expect(page1.learners).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getOrganizationCapabilityReport(tenant.id, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.learners).toHaveLength(2);

    const page3 = await getOrganizationCapabilityReport(tenant.id, {
      limit: 2,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.learners).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.learners, ...page2.learners, ...page3.learners].map((l) => l.userId);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toHaveLength(names.length);
  });

  it("handles duplicate names deterministically via email/id tie-break", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await seedLearners(tenant.id, role.id, ["Same", "Same", "Same"]);

    const page1 = await getOrganizationCapabilityReport(tenant.id, { limit: 2 });
    const page2 = await getOrganizationCapabilityReport(tenant.id, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });

    const allIds = [...page1.learners, ...page2.learners].map((l) => l.userId);
    expect(new Set(allIds).size).toBe(3);
  });

  it("an invalid/undecodable cursor throws OrgCapabilityCursorError", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    await expect(
      getOrganizationCapabilityReport(tenant.id, { cursor: "not-a-valid-cursor!!" })
    ).rejects.toThrow();
  });

  /**
   * Creates users in a fixed, index-derived order: emails are zero-padded by
   * creation index (`<runId>-000@`, `<runId>-001@`, ...), so email ASC always
   * equals creation order — this makes the expected keyset order for a mix
   * of named/null-named entries fully predictable without depending on
   * `Math.random()` string comparisons.
   */
  async function seedLearnersOrdered(
    tenantId: string,
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
      created.push({ id: user.id, name: user.name, email: user.email });
    }
    return created;
  }

  /** Same ordering rule the implementation uses: name ASC (nulls last), email ASC, id ASC. */
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

  it("named -> unnamed boundary: named users on page 1, null-named users on page 2, no skip/duplicate", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    // Indices 0/1 named (alphabetically first), indices 2/3 null — email
    // order (by creation index) matches the expected name-then-null split.
    const created = await seedLearnersOrdered(tenant.id, role.id, [
      { name: "Amy" },
      { name: "Bob" },
      { name: null },
      { name: null },
    ]);
    const [amy, bob, null1, null2] = created;

    const page1 = await getOrganizationCapabilityReport(tenant.id, { limit: 2 });
    expect(page1.learners.map((l) => l.userId)).toEqual([amy.id, bob.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getOrganizationCapabilityReport(tenant.id, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.learners.map((l) => l.userId)).toEqual([null1.id, null2.id]);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.learners, ...page2.learners].map((l) => l.userId);
    expect(new Set(allIds).size).toBe(4);
  });

  it("unnamed -> unnamed continuation: pagination stays correct within the NULLS LAST tail", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const created = await seedLearnersOrdered(tenant.id, role.id, [
      { name: null },
      { name: null },
      { name: null },
    ]);
    const [first, second, third] = created;

    const page1 = await getOrganizationCapabilityReport(tenant.id, { limit: 2 });
    expect(page1.learners.map((l) => l.userId)).toEqual([first.id, second.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getOrganizationCapabilityReport(tenant.id, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.learners.map((l) => l.userId)).toEqual([third.id]);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.learners, ...page2.learners].map((l) => l.userId);
    expect(new Set(allIds).size).toBe(3);
  });

  it("full pagination integrity across a mixed named/null-named population matches the expected global sort order", async () => {
    const { tenant } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    const created = await seedLearnersOrdered(tenant.id, role.id, [
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
      const page = await getOrganizationCapabilityReport(tenant.id, { limit: 2, cursor });
      collected.push(...page.learners.map((l) => l.userId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(collected).toEqual(expectedOrder(created).map((u) => u.id));
    expect(new Set(collected).size).toBe(created.length);
  });
});

describe("getOrganizationCapabilityReport — no N+1 reuse of self-scoped functions", () => {
  it("does not call computeCapabilityGap per learner", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const role = await createJobRole(tenant.id);
    await createUserJobRole(tenant.id, ctx.userId, role.id);

    const spy = vi.spyOn(gapsModule, "computeCapabilityGap");
    await getOrganizationCapabilityReport(tenant.id);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
