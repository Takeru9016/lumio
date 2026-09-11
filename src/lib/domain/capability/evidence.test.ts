import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSkill } from "@/lib/domain/capability/__test__/fixtures";
import { getSkillEvidenceForUser } from "@/lib/domain/capability/evidence";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function createEvidence(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  type?: "COURSE_COMPLETION" | "QUIZ_SCORE" | "MANUAL";
  score?: number | null;
  verificationStatus?: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
  createdAt?: Date;
  sourceId?: string;
}) {
  return db.skillEvidence.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      skillId: params.skillId,
      type: params.type ?? "MANUAL",
      sourceType: "Manual",
      sourceId: params.sourceId ?? `manual-${Math.random()}`,
      score: params.score ?? null,
      verificationStatus: params.verificationStatus ?? "UNVERIFIED",
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    },
  });
}

describe("getSkillEvidenceForUser — empty", () => {
  it("no evidence -> empty result", async () => {
    const { tenant, ctx } = await createTenantUser();
    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    expect(result).toEqual([]);
  });
});

describe("getSkillEvidenceForUser — multiple evidence", () => {
  it("multiple evidence rows for one skill are all returned", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({ tenantId: tenant.id, userId: ctx.userId, skillId: skill.id });
    await createEvidence({ tenantId: tenant.id, userId: ctx.userId, skillId: skill.id });

    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.skillId === skill.id)).toBe(true);
    expect(result.every((e) => e.skillName === skill.name)).toBe(true);
  });

  it("evidence across multiple skills is all returned", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    await createEvidence({ tenantId: tenant.id, userId: ctx.userId, skillId: skillA.id });
    await createEvidence({ tenantId: tenant.id, userId: ctx.userId, skillId: skillB.id });

    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    expect(result).toHaveLength(2);
    expect(new Set(result.map((e) => e.skillId))).toEqual(new Set([skillA.id, skillB.id]));
  });
});

describe("getSkillEvidenceForUser — deterministic ordering", () => {
  it("orders by createdAt descending (newest first)", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const older = await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    const newer = await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });

    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    expect(result.map((e) => e.id)).toEqual([newer.id, older.id]);
  });

  it("ties on createdAt break by id ascending", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const sameInstant = new Date("2024-06-01T00:00:00Z");
    const first = await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      createdAt: sameInstant,
    });
    const second = await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      createdAt: sameInstant,
    });

    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    const [expectedFirst, expectedSecond] = [first.id, second.id].sort();
    expect(result.map((e) => e.id)).toEqual([expectedFirst, expectedSecond]);
  });
});

describe("getSkillEvidenceForUser — security", () => {
  it("another user's evidence is excluded", async () => {
    const { tenant, ctx: callerCtx } = await createTenantUser();
    const { ctx: otherCtx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({ tenantId: tenant.id, userId: otherCtx.userId, skillId: skill.id });

    const result = await getSkillEvidenceForUser({ ...callerCtx, tenantId: tenant.id });
    expect(result).toEqual([]);
  });

  it("another tenant's evidence for the same user id is excluded by the tenant filter", async () => {
    const { tenant, ctx: callerCtx } = await createTenantUser();
    const { tenant: otherTenant } = await createTenantUser();
    const otherSkill = await createSkill(otherTenant.id);
    // Malformed/impossible-in-practice row: caller's own userId, but under
    // a different tenant — proves the tenantId filter alone (not just
    // userId) is what excludes it.
    await createEvidence({
      tenantId: otherTenant.id,
      userId: callerCtx.userId,
      skillId: otherSkill.id,
    });

    const result = await getSkillEvidenceForUser({ ...callerCtx, tenantId: tenant.id });
    expect(result).toEqual([]);
  });

  it("mixed user/tenant fixture data returns only the caller's own evidence", async () => {
    const { tenant, ctx: callerCtx } = await createTenantUser();
    const { ctx: sameTenantOtherUser } = await createTenantUser();
    const { tenant: otherTenant, ctx: otherTenantUser } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const otherSkill = await createSkill(otherTenant.id);

    const mine = await createEvidence({
      tenantId: tenant.id,
      userId: callerCtx.userId,
      skillId: skill.id,
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: sameTenantOtherUser.userId,
      skillId: skill.id,
    });
    await createEvidence({
      tenantId: otherTenant.id,
      userId: otherTenantUser.userId,
      skillId: otherSkill.id,
    });

    const result = await getSkillEvidenceForUser({ ...callerCtx, tenantId: tenant.id });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(mine.id);
  });
});

describe("getSkillEvidenceForUser — verification status and score", () => {
  it("returns evidence at every verification status without altering it", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "UNVERIFIED",
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "VERIFIED",
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "REJECTED",
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "PENDING",
    });

    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    expect(result).toHaveLength(4);
    const statuses = result.map((e) => e.verificationStatus).sort();
    expect(statuses).toEqual(["PENDING", "REJECTED", "UNVERIFIED", "VERIFIED"]);
  });

  it("preserves a null score", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      type: "COURSE_COMPLETION",
      score: null,
    });

    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    expect(result[0].score).toBeNull();
  });

  it("preserves a numeric score, unmodified", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      type: "QUIZ_SCORE",
      score: 87,
    });

    const result = await getSkillEvidenceForUser({ ...ctx, tenantId: tenant.id });
    expect(result[0].score).toBe(87);
  });
});
