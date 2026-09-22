import { afterAll, describe, expect, it } from "vitest";
import type { EvidenceState } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createSkill } from "@/lib/domain/capability/__test__/fixtures";
import { recordSkillEvidenceOutcome } from "@/lib/domain/capability/outcomes";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * Phase 30.1 — schema foundation only (no runtime wiring). These tests prove
 * the migration is additive and inert: existing writers are untouched,
 * every new column defaults to the migration-safe neutral value the
 * contract specifies, no history event is ever written by a V1 code path,
 * and the one approved composite tenant FK actually rejects what it's meant
 * to reject. See docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md,
 * docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_PREFLIGHT.md §5/§19/§24.
 */

afterAll(async () => {
  await db.$disconnect();
});

describe("SkillEvidence — additive columns", () => {
  it("a row written by the real production writer gets the migration-safe neutral defaults, untouched by that writer", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);

    const created = await recordSkillEvidenceOutcome({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      type: "MANUAL",
      sourceType: "Manual",
      sourceId: "phase-30-foundation-test",
      occurredAt: new Date(),
    });
    expect(created).toBe(true);

    const row = await db.skillEvidence.findFirstOrThrow({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(row.state).toBe("ACTIVE");
    expect(row.revision).toBe(0);
    expect(row.occurredAt).toBeNull();
    expect(row.validUntil).toBeNull();
    expect(row.scorePercent).toBeNull();
  });

  it("the pre-existing columns V2 already deprecated still accept a write — nothing was dropped", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);

    const row = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "phase-30-legacy-columns",
        proficiency: "BEGINNER",
        score: 42,
        metadata: { legacy: true },
      },
    });
    expect(row.proficiency).toBe("BEGINNER");
    expect(row.score).toBe(42);
    expect(row.metadata).toEqual({ legacy: true });
    // and the new columns still default correctly alongside them
    expect(row.state).toBe("ACTIVE");
    expect(row.revision).toBe(0);
  });
});

describe("UserSkill — additive columns", () => {
  it("a row projected by the real production writer gets the migration-safe neutral defaults", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);

    await recordSkillEvidenceOutcome({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      type: "MANUAL",
      sourceType: "Manual",
      sourceId: "phase-30-userskill-defaults",
      occurredAt: new Date(),
    });

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    // V1 behavior unchanged: still projects to BEGINNER for unverified evidence.
    expect(userSkill.proficiency).toBe("BEGINNER");
    // New V2 columns: untouched by the unmodified writer.
    expect(userSkill.eventSeq).toBe(0);
    expect(userSkill.evidenceConfidence).toBeNull();
    expect(userSkill.policyVersion).toBeNull();
  });

  it("the pre-existing deprecated columns still accept a write — nothing was dropped", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);

    const row = await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        confidence: 7,
        targetProficiency: "ADVANCED",
        status: "ACTIVE",
      },
    });
    expect(row.confidence).toBe(7);
    expect(row.targetProficiency).toBe("ADVANCED");
  });

  it("the composite tenant FK (skillId, tenantId) -> Skill(id, tenantId) rejects a cross-tenant UserSkill row", async () => {
    const { tenant: tenantA, ctx } = await createTenantUser("STUDENT");
    const { tenant: tenantB } = await createTenantUser("STUDENT");
    const foreignSkill = await createSkill(tenantB.id);

    // The existing single-column skillId->Skill(id) FK alone would allow
    // this (the skill genuinely exists); the new composite FK is the one
    // that must reject it — this is the pre-flight audit's one approved,
    // "safe to add now" tenant relationship (§5/§24), proven here.
    await expect(
      db.userSkill.create({
        data: {
          tenantId: tenantA.id, // learner's own tenant
          userId: ctx.userId,
          skillId: foreignSkill.id, // but the skill belongs to tenant B
        },
      })
    ).rejects.toThrow();
  });

  it("a same-tenant UserSkill row is unaffected by the new FK", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);

    const row = await db.userSkill.create({
      data: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(row.skillId).toBe(skill.id);
  });
});

describe("SkillProficiencyEvent — schema exists, nothing writes to it yet", () => {
  it("no V1 production writer (course completion evidence) creates a row here", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);

    await recordSkillEvidenceOutcome({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      type: "MANUAL",
      sourceType: "Manual",
      sourceId: "phase-30-no-events-yet",
      occurredAt: new Date(),
    });

    const count = await db.skillProficiencyEvent.count({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(count).toBe(0);
  });

  it("the table's shape supports every field the contract's history questions need, and its uniqueness constraints hold", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "phase-30-event-shape",
      },
    });

    const event = await db.skillProficiencyEvent.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        seq: 1,
        cause: "BASELINE",
        evidenceId: evidence.id,
        evidenceRevision: 0,
        actorId: null,
        actorRole: null,
        reason: null,
        previousProficiency: null,
        newProficiency: "BEGINNER",
        previousConfidence: null,
        newConfidence: "LOW",
        policyVersion: 1,
        contributing: [
          { evidenceId: evidence.id, type: "MANUAL", verificationStatus: "UNVERIFIED" },
        ],
        occurredAt: new Date(),
      },
    });
    expect(event.cause).toBe("BASELINE");
    expect(event.seq).toBe(1);

    // @@unique([userId, skillId, seq]) — a second event for the same
    // (user, skill) must not silently reuse seq=1.
    await expect(
      db.skillProficiencyEvent.create({
        data: {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          seq: 1,
          cause: "RECALCULATED",
          newProficiency: "BEGINNER",
          policyVersion: 1,
          occurredAt: new Date(),
        },
      })
    ).rejects.toThrow();

    // @@unique([evidenceId, evidenceRevision]) — a second event for the same
    // evidence transition (same evidenceId + evidenceRevision) is rejected too.
    await expect(
      db.skillProficiencyEvent.create({
        data: {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          seq: 2,
          cause: "EVIDENCE_VERIFIED",
          evidenceId: evidence.id,
          evidenceRevision: 0,
          newProficiency: "INTERMEDIATE",
          policyVersion: 1,
          occurredAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });

  it("evidenceId cascades to null on evidence deletion — history is never held hostage by a deleted row", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "phase-30-cascade",
      },
    });
    const event = await db.skillProficiencyEvent.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        seq: 1,
        cause: "BASELINE",
        evidenceId: evidence.id,
        newProficiency: "BEGINNER",
        policyVersion: 1,
        occurredAt: new Date(),
      },
    });

    await db.skillEvidence.delete({ where: { id: evidence.id } });

    const reread = await db.skillProficiencyEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reread.evidenceId).toBeNull();
  });
});

describe("no destructive migration", () => {
  it("every EvidenceState value round-trips through the database, not just through SQL strings", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    const states: EvidenceState[] = ["ACTIVE", "SUPERSEDED", "EXPIRED", "REVOKED"];

    for (const [index, state] of states.entries()) {
      const row = await db.skillEvidence.create({
        data: {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          type: "MANUAL",
          sourceType: "Manual",
          sourceId: `phase-30-state-${index}`,
          state,
        },
      });
      expect(row.state).toBe(state);
    }
  });
});
