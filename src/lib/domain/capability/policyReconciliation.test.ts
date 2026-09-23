import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSkill } from "@/lib/domain/capability/__test__/fixtures";
import { reconcileTenant } from "@/lib/domain/capability/policyReconciliation";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function evidenceRow(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  sourceId: string;
  verificationStatus?: "UNVERIFIED" | "VERIFIED" | "REJECTED";
}) {
  return db.skillEvidence.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      skillId: params.skillId,
      type: "MANUAL",
      sourceType: "Manual",
      sourceId: params.sourceId,
      verificationStatus: params.verificationStatus ?? "UNVERIFIED",
    },
  });
}

describe("reconcileTenant — Phase 30.2 V1-vs-Policy-1 proof", () => {
  it("a row whose stored value matches its evidence is EXACT_MATCH", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
      verificationStatus: "VERIFIED",
    });
    await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        proficiency: "INTERMEDIATE",
      },
    });

    const summary = await reconcileTenant(tenant.id);
    expect(summary.total).toBe(1);
    expect(summary.exactMatch).toBe(1);
    expect(summary.unexplained).toBe(0);
  });

  it("a row with no evidence at all, stored above NONE, is FIXTURE_ONLY, not UNEXPLAINED", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "BEGINNER" },
    });

    const summary = await reconcileTenant(tenant.id);
    expect(summary.total).toBe(1);
    expect(summary.fixtureOnly).toBe(1);
    expect(summary.exactMatch).toBe(0);
    expect(summary.unexplained).toBe(0);
  });

  it("a row stored at ADVANCED/EXPERT — unreachable under Policy 1 — is EXPLAINABLE_LEGACY even when evidence exists", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
      verificationStatus: "VERIFIED",
    });
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "ADVANCED" },
    });

    const summary = await reconcileTenant(tenant.id);
    expect(summary.total).toBe(1);
    expect(summary.explainableLegacy).toBe(1);
    expect(summary.unexplained).toBe(0);
  });

  it("a stored non-NONE value paired with a single REJECTED (non-contributing) evidence row is FIXTURE_ONLY, not UNEXPLAINED — the exact pattern found in this repo's real test database", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
      verificationStatus: "REJECTED",
    });
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "BEGINNER" },
    });

    const summary = await reconcileTenant(tenant.id);
    expect(summary.fixtureOnly).toBe(1);
    expect(summary.unexplained).toBe(0);
  });

  it("a REAL writer's row (lastAssessedAt set) whose only evidence is force-rejected OUTSIDE verification.ts (bypassing its guaranteed recompute) is STILL FIXTURE_ONLY via the contributing-count marker, distinct from the lastAssessedAt marker", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const evidence = await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
    });
    // A real recompute — lastAssessedAt is genuinely set here, ruling out
    // the lastAssessedAt=null marker entirely for this row.
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    // Simulate the one way contract F2's "every evidence-standing change
    // recomputes in the same transaction" could be bypassed: a raw update
    // to verificationStatus that does NOT go through verification.ts (which
    // always recomputes). This is exactly the shape contract §H6's audit
    // looks for — evidence standing changed without a corresponding
    // recompute — and it must still resolve to FIXTURE_ONLY (a data-repair/
    // migration-shaped anomaly, not a fresh unexplained production defect),
    // via the contributingCount marker specifically, since lastAssessedAt
    // is non-null here.
    await db.skillEvidence.update({
      where: { id: evidence.id },
      data: { verificationStatus: "REJECTED" },
    });

    const summary = await reconcileTenant(tenant.id);
    expect(summary.fixtureOnly).toBe(1);
    expect(summary.unexplained).toBe(0);
  });

  it("a UserSkill row with lastAssessedAt still null (never recomputed by any writer) is FIXTURE_ONLY even though its evidence genuinely contributes", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
    });
    // lastAssessedAt defaults to null on a direct create — no writer has
    // touched this row, even though the evidence would compute to BEGINNER.
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "NONE" },
    });

    const summary = await reconcileTenant(tenant.id);
    expect(summary.fixtureOnly).toBe(1);
    expect(summary.unexplained).toBe(0);
  });

  it("a row genuinely recomputed by a real writer (lastAssessedAt set), then drifted out of sync with its evidence -> UNEXPLAINED, with a sample recorded", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
    });
    // A REAL recompute — sets lastAssessedAt for real, the marker that rules
    // out both FIXTURE_ONLY paths above. Projects to BEGINNER correctly.
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    // Simulate drift: the stored projection is forced back to NONE without
    // going through recompute — evidence (and lastAssessedAt) unchanged.
    // This is what a genuine, unexplained bug would look like: a row a real
    // writer touched, now out of sync with its own evidence.
    await db.userSkill.update({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
      data: { proficiency: "NONE" },
    });

    try {
      const summary = await reconcileTenant(tenant.id);
      expect(summary.unexplained).toBe(1);
      expect(summary.unexplainedSamples).toHaveLength(1);
      expect(summary.unexplainedSamples[0].storedProficiency).toBe("NONE");
      expect(summary.unexplainedSamples[0].computedProficiency).toBe("BEGINNER");
    } finally {
      // This repo's test database is never truncated between runs (session
      // convention) — a deliberately-drifted, genuinely UNEXPLAINED row left
      // behind here would permanently keep any future reconciliation run
      // against this database from reading zero unexplained mismatches.
      // Restore consistency so this test proves the UNEXPLAINED path fires
      // without leaving a standing false alarm for every later run.
      await db.userSkill.update({
        where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
        data: { proficiency: "BEGINNER" },
      });
    }
  });

  it("REJECTED evidence never contributes to the computed value used for comparison", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
      verificationStatus: "REJECTED",
    });
    await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "NONE" },
    });

    const summary = await reconcileTenant(tenant.id);
    expect(summary.exactMatch).toBe(1);
  });

  it("a foreign-tenant evidence row never contributes — tenant isolation (INV3) holds during reconciliation", async () => {
    const { tenant: tenantA, ctx } = await createTenantUser();
    const { tenant: tenantB } = await createTenantUser();
    const skill = await createSkill(tenantA.id);
    // A same-user, same-skill row belonging to a DIFFERENT tenant must never
    // be pulled into tenantA's evidence set (tenantId is part of the query).
    await db.skillEvidence.create({
      data: {
        tenantId: tenantB.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "cross-tenant",
        verificationStatus: "VERIFIED",
      },
    });
    await db.userSkill.create({
      data: { tenantId: tenantA.id, userId: ctx.userId, skillId: skill.id, proficiency: "NONE" },
    });

    const summary = await reconcileTenant(tenantA.id);
    // No same-tenant evidence -> FIXTURE_ONLY would fire only if stored > NONE;
    // stored is NONE and computed is NONE (the foreign row must be excluded) -> EXACT_MATCH.
    expect(summary.exactMatch).toBe(1);
    expect(summary.unexplained).toBe(0);
  });

  it("batches correctly across more rows than one batch size", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skills = await Promise.all(Array.from({ length: 5 }, () => createSkill(tenant.id)));
    for (const skill of skills) {
      await db.userSkill.create({
        data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id, proficiency: "NONE" },
      });
    }

    const summary = await reconcileTenant(tenant.id, { batchSize: 2 });
    expect(summary.total).toBe(5);
    expect(summary.exactMatch).toBe(5);
  });

  it("an unrelated tenant's rows never appear in this tenant's summary", async () => {
    const { tenant: tenantA, ctx: ctxA } = await createTenantUser();
    const { tenant: tenantB, ctx: ctxB } = await createTenantUser();
    const skillA = await createSkill(tenantA.id);
    const skillB = await createSkill(tenantB.id);
    await db.userSkill.create({
      data: { tenantId: tenantA.id, userId: ctxA.userId, skillId: skillA.id, proficiency: "NONE" },
    });
    await db.userSkill.create({
      data: {
        tenantId: tenantB.id,
        userId: ctxB.userId,
        skillId: skillB.id,
        proficiency: "ADVANCED",
      },
    });

    const summaryA = await reconcileTenant(tenantA.id);
    expect(summaryA.total).toBe(1);
    expect(summaryA.explainableLegacy).toBe(0);
  });
});
