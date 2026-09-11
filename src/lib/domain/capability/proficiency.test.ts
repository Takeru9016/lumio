import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSkill } from "@/lib/domain/capability/__test__/fixtures";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function createEvidence(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  verificationStatus: "UNVERIFIED" | "VERIFIED" | "REJECTED" | "PENDING";
}) {
  return db.skillEvidence.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      skillId: params.skillId,
      type: "MANUAL",
      sourceType: "Manual",
      sourceId: `manual-${Math.random()}`,
      verificationStatus: params.verificationStatus,
    },
  });
}

describe("projectUserSkill", () => {
  it("creates UserSkill at NONE when no evidence exists yet", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const changeTimestamp = new Date();

    const result = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp,
      })
    );

    expect(result.proficiency).toBe("NONE");
    expect(result.lastAssessedAt?.getTime()).toBe(changeTimestamp.getTime());
  });

  it("UNVERIFIED evidence projects to BEGINNER", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "UNVERIFIED",
    });

    const result = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    expect(result.proficiency).toBe("BEGINNER");
  });

  it("VERIFIED evidence projects to INTERMEDIATE", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "VERIFIED",
    });

    const result = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    expect(result.proficiency).toBe("INTERMEDIATE");
  });

  it("PENDING evidence is treated explicitly, identically to UNVERIFIED (BEGINNER) — not silently guessed", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "PENDING",
    });

    const result = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    expect(result.proficiency).toBe("BEGINNER");
  });

  it("REJECTED evidence contributes nothing", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "REJECTED",
    });

    const result = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    expect(result.proficiency).toBe("NONE");
  });

  it("multiple evidence rows use the maximum ceiling, and it never exceeds INTERMEDIATE in Phase 5", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
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
      verificationStatus: "VERIFIED",
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "UNVERIFIED",
    });

    const result = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    expect(result.proficiency).toBe("INTERMEDIATE");
    expect(result.proficiency).not.toBe("ADVANCED");
    expect(result.proficiency).not.toBe("EXPERT");
  });

  it("is order-independent — same evidence set, created in reversed order, produces the same result", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);

    // Scenario A: UNVERIFIED then VERIFIED.
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skillA.id,
      verificationStatus: "UNVERIFIED",
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skillA.id,
      verificationStatus: "VERIFIED",
    });

    // Scenario B: VERIFIED then UNVERIFIED (reversed).
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skillB.id,
      verificationStatus: "VERIFIED",
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skillB.id,
      verificationStatus: "UNVERIFIED",
    });

    const [resultA, resultB] = await Promise.all([
      db.$transaction((tx) =>
        projectUserSkill(tx, {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skillA.id,
          changeTimestamp: new Date(),
        })
      ),
      db.$transaction((tx) =>
        projectUserSkill(tx, {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skillB.id,
          changeTimestamp: new Date(),
        })
      ),
    ]);

    expect(resultA.proficiency).toBe(resultB.proficiency);
    expect(resultA.proficiency).toBe("INTERMEDIATE");
  });

  it("lastAssessedAt only changes when the projected proficiency actually changes", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "UNVERIFIED",
    });

    const first = new Date("2026-01-01T00:00:00Z");
    const result1 = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: first,
      })
    );
    expect(result1.proficiency).toBe("BEGINNER");
    expect(result1.lastAssessedAt?.toISOString()).toBe(first.toISOString());

    // Recompute again with the same evidence set (proficiency unchanged) —
    // a later changeTimestamp must NOT overwrite lastAssessedAt.
    const later = new Date("2026-06-01T00:00:00Z");
    const result2 = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: later,
      })
    );
    expect(result2.proficiency).toBe("BEGINNER");
    expect(result2.lastAssessedAt?.toISOString()).toBe(first.toISOString());
  });

  it("never writes confidence, targetProficiency, or status", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        proficiency: "NONE",
        confidence: 42,
        targetProficiency: "ADVANCED",
        status: "ACTIVE",
      },
    });
    await createEvidence({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      verificationStatus: "VERIFIED",
    });

    const result = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );

    expect(result.proficiency).toBe("INTERMEDIATE");
    expect(result.confidence).toBe(42);
    expect(result.targetProficiency).toBe("ADVANCED");
    expect(result.status).toBe("ACTIVE");
  });
});
