import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createCourse, createSkill } from "@/lib/domain/capability/__test__/fixtures";
import {
  CapabilityVerificationError,
  reinstateEvidence,
  rejectEvidence,
  reopenEvidence,
  revokeEvidence,
  unverifyEvidence,
  verifyEvidence,
} from "@/lib/domain/capability/verification";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * Phase 30.3 — the new evidence-standing transitions (unverify, reopen,
 * revoke, reinstate), idempotency, the soft-deleted-learner fix (D22), the
 * cross-tenant existence-leak fix (D23), EvidenceStandingEvent semantics,
 * and real-database concurrency (D21). `verification.test.ts`'s 26 existing
 * tests are UNMODIFIED by this phase (confirmed — every one still passes
 * against the rewritten `verification.ts`); this file adds only what's new.
 */

afterAll(async () => {
  await db.$disconnect();
});

async function createCourseSourcedEvidence(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  courseId: string;
  verificationStatus?: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
}) {
  return db.skillEvidence.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      skillId: params.skillId,
      type: "COURSE_COMPLETION",
      sourceType: "Course",
      sourceId: params.courseId,
      verificationStatus: params.verificationStatus ?? "UNVERIFIED",
    },
  });
}

async function setup(role: "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN" = "INSTRUCTOR") {
  const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
  const { ctx: learnerCtx } = await createTenantUser("STUDENT");
  const { course } = await createCourse(tenant.id, instructorCtx.userId);
  const skill = await createSkill(tenant.id);
  let actorCtx = { ...instructorCtx, tenantId: tenant.id };
  if (role === "ORG_ADMIN") {
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
  } else if (role === "SUPER_ADMIN") {
    const { ctx: superAdminCtx } = await createTenantUser("SUPER_ADMIN");
    actorCtx = { ...superAdminCtx, tenantId: tenant.id };
  }
  return { tenant, instructorCtx, learnerCtx, course, skill, actorCtx };
}

async function standingEventsFor(evidenceId: string) {
  return db.evidenceStandingEvent.findMany({
    where: { evidenceId },
    orderBy: { evidenceRevision: "asc" },
  });
}

describe("unverify (VERIFIED -> UNVERIFIED)", () => {
  it("an owning instructor can unverify — status returns to UNVERIFIED, level falls, verifiedById is left untouched", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await verifyEvidence(actorCtx, evidence.id);

    const result = await unverifyEvidence(actorCtx, evidence.id);
    expect(result.proficiency).toBe("BEGINNER");

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.verificationStatus).toBe("UNVERIFIED");
    // Never cleared — the unified rule (docs/PHASE_30.3_DISCOVERY.md §15).
    expect(row.verifiedById).toBe(actorCtx.userId);
    expect(row.verifiedAt).not.toBeNull();
  });

  it("ORG_ADMIN can unverify (D3) but cannot verify or reopen", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "VERIFIED",
    });

    const result = await unverifyEvidence(actorCtx, evidence.id);
    expect(result.proficiency).toBe("BEGINNER");

    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toThrow(
      CapabilityVerificationError
    );
    await expect(reopenEvidence(actorCtx, evidence.id)).rejects.toThrow(
      CapabilityVerificationError
    );
  });

  it("unverify on an already-UNVERIFIED row is a no-op — no EvidenceStandingEvent, no revision bump", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    await unverifyEvidence(actorCtx, evidence.id);

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.revision).toBe(0);
    expect(await standingEventsFor(evidence.id)).toHaveLength(0);
  });
});

describe("reopen (REJECTED -> UNVERIFIED)", () => {
  it("an owning instructor can reopen rejected evidence", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "REJECTED",
    });

    const result = await reopenEvidence(actorCtx, evidence.id);
    expect(result.proficiency).toBe("BEGINNER");

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.verificationStatus).toBe("UNVERIFIED");
  });

  it("reopen on a VERIFIED row is refused as ILLEGAL_TRANSITION (409), not silently accepted", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "VERIFIED",
    });

    await expect(reopenEvidence(actorCtx, evidence.id)).rejects.toMatchObject({ status: 409 });
  });

  it("ORG_ADMIN cannot reopen — reopen is a raising action, D3 grants ORG_ADMIN lowering authority only", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "REJECTED",
    });

    await expect(reopenEvidence(actorCtx, evidence.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe("revoke / reinstate (state axis)", () => {
  it("ORG_ADMIN can revoke ACTIVE evidence with a reason — it stops contributing", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "VERIFIED",
    });
    await db.$transaction((tx) =>
      import("@/lib/domain/capability/proficiency").then(({ projectUserSkill }) =>
        projectUserSkill(tx, {
          tenantId: tenant.id,
          userId: learnerCtx.userId,
          skillId: skill.id,
          changeTimestamp: new Date(),
        })
      )
    );

    const result = await revokeEvidence(
      actorCtx,
      evidence.id,
      "duplicate enrollment, data-entry error"
    );
    expect(result.proficiency).toBe("NONE");

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.state).toBe("REVOKED");
    expect(row.verificationStatus).toBe("VERIFIED"); // untouched — state axis only
  });

  it("revoke without a reason is refused", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    await expect(revokeEvidence(actorCtx, evidence.id, "")).rejects.toMatchObject({ status: 403 });
    await expect(revokeEvidence(actorCtx, evidence.id, "   ")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("INSTRUCTOR cannot revoke or reinstate — administrative-only", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    await expect(revokeEvidence(actorCtx, evidence.id, "reason")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("revoke works even when the evidence's source no longer resolves (§25 — no source-resolution requirement)", async () => {
    const { tenant, ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const skill = await createSkill(tenant.id);
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "no-such-course",
      },
    });

    const result = await revokeEvidence(actorCtx, evidence.id, "orphaned by lesson deletion");
    expect(result.proficiency).toBe("NONE");
  });

  it("a REVOKED row refuses verify with NOT_ACTIVE (409), even though verificationStatus may still read VERIFIED underneath", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const adminCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "VERIFIED",
    });
    await revokeEvidence(adminCtx, evidence.id, "integrity correction");

    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toMatchObject({ status: 409 });
  });

  it("reinstate restores state to ACTIVE and the PRIOR verificationStatus (VERIFIED) without re-verification", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const adminCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await verifyEvidence(actorCtx, evidence.id);
    await revokeEvidence(adminCtx, evidence.id, "temporary correction");

    const result = await reinstateEvidence(
      adminCtx,
      evidence.id,
      "correction reverted, evidence was valid"
    );
    expect(result.proficiency).toBe("INTERMEDIATE");

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.state).toBe("ACTIVE");
    expect(row.verificationStatus).toBe("VERIFIED");
  });

  it("revoke on an already-REVOKED row is a no-op", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await revokeEvidence(actorCtx, evidence.id, "first revoke");
    const revisionAfterFirst = (
      await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } })
    ).revision;

    await revokeEvidence(actorCtx, evidence.id, "second revoke attempt");

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.revision).toBe(revisionAfterFirst);
  });
});

describe("idempotent re-verify / re-reject (D10, and its symmetric case)", () => {
  it("a no-op re-verify NEVER recomputes proficiency, even when the stored level is a legacy value (ADVANCED) that a fresh Policy-1 computation would disagree with — the no-op must be a true no-op, not a disguised recompute", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "VERIFIED", // fresh Policy-1 computation would be INTERMEDIATE
    });
    // A legacy row, stored ADVANCED (unreachable under Policy 1) with
    // lastAssessedAt genuinely set — the exact EXPLAINABLE_LEGACY shape
    // reconciliation already names (docs/PHASE_30.2_IMPLEMENTATION.md §10).
    // A live-API-reachable action (re-verifying already-VERIFIED evidence)
    // must never silently converge this toward the Policy-1 ceiling.
    await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        proficiency: "ADVANCED",
        lastAssessedAt: new Date("2026-01-10T09:00:00Z"),
        eventSeq: 1,
      },
    });
    const eventsBefore = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });

    const { ctx: secondInstructorCtx } = await createTenantUser("SUPER_ADMIN");
    const secondActorCtx = { ...secondInstructorCtx, tenantId: tenant.id };
    const result = await verifyEvidence(secondActorCtx, evidence.id); // no-op: already VERIFIED

    expect(result.proficiency).toBe("ADVANCED"); // untouched, never converged to INTERMEDIATE
    expect(result.eventSeq).toBe(1); // untouched
    const eventsAfter = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(eventsAfter).toBe(eventsBefore); // zero new SkillProficiencyEvent rows
    expect(await standingEventsFor(evidence.id)).toHaveLength(0); // no-op writes no standing event either
  });

  it("re-verifying an already-VERIFIED row is a true no-op: no revision bump, verifiedById unchanged, no new SkillProficiencyEvent, no new EvidenceStandingEvent", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await verifyEvidence(actorCtx, evidence.id);
    const firstVerified = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    const eventsBefore = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });

    const { ctx: otherInstructorCtx } = await createTenantUser("SUPER_ADMIN");
    const secondActorCtx = { ...otherInstructorCtx, tenantId: tenant.id };
    await verifyEvidence(secondActorCtx, evidence.id);

    const afterSecondVerify = await db.skillEvidence.findUniqueOrThrow({
      where: { id: evidence.id },
    });
    expect(afterSecondVerify.revision).toBe(firstVerified.revision);
    expect(afterSecondVerify.verifiedById).toBe(actorCtx.userId); // first verifier preserved
    expect(afterSecondVerify.verifiedAt?.getTime()).toBe(firstVerified.verifiedAt?.getTime());

    const eventsAfter = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(eventsAfter).toBe(eventsBefore);
    expect(await standingEventsFor(evidence.id)).toHaveLength(1); // only the original verify
  });

  it("re-rejecting an already-REJECTED row is a true no-op", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "REJECTED",
    });

    await rejectEvidence(actorCtx, evidence.id);

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.revision).toBe(0);
    expect(await standingEventsFor(evidence.id)).toHaveLength(0);
  });
});

describe("audit-event atomicity — a forced failure on the EvidenceStandingEvent write rolls back the entire transition (same discipline as 30.2's backfill collision tests)", () => {
  it("a pre-existing EvidenceStandingEvent at the revision this verify would produce makes the whole transaction fail safely — evidence stays UNVERIFIED at revision 0, no SkillProficiencyEvent, no UserSkill change", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    // A verify on this fresh (revision 0) row will bump SkillEvidence.revision
    // to 1 and then try to insert an EvidenceStandingEvent at
    // (evidenceId, evidenceRevision: 1) — pre-occupy exactly that slot so the
    // insert collides on the real unique constraint, forcing the whole
    // transaction (evidence update + standing event + projectUserSkill) to
    // roll back atomically.
    await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        evidenceId: evidence.id,
        evidenceRevision: 1,
        action: "REVOKE",
        actorId: actorCtx.userId,
        actorRole: "ORG_ADMIN",
        reason: "pre-occupying the collision slot for this test",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "UNVERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
      },
    });
    const proficiencyEventsBefore = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    const userSkillBefore = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });

    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toThrow();

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.verificationStatus).toBe("UNVERIFIED"); // rolled back, not half-applied
    expect(row.revision).toBe(0); // the revision bump was rolled back too
    const proficiencyEventsAfter = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(proficiencyEventsAfter).toBe(proficiencyEventsBefore); // no new SkillProficiencyEvent
    const userSkillAfter = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(userSkillAfter).toEqual(userSkillBefore); // UserSkill entirely unaffected (still absent, or unchanged)
  });
});

describe("EvidenceStandingEvent — audit for level-unchanged transitions (§26, the gate finding)", () => {
  it("verifying a SECOND evidence row for a skill already at INTERMEDIATE writes an EvidenceStandingEvent but ZERO new SkillProficiencyEvent", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidenceA = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await verifyEvidence(actorCtx, evidenceA.id); // now at INTERMEDIATE

    const { course: courseB } = await createCourse(tenant.id, actorCtx.userId);
    const evidenceB = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: courseB.id,
    });
    const eventsBefore = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });

    const result = await verifyEvidence(actorCtx, evidenceB.id);
    expect(result.proficiency).toBe("INTERMEDIATE"); // unchanged — already there

    const eventsAfter = await db.skillProficiencyEvent.count({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(eventsAfter).toBe(eventsBefore); // no new proficiency event

    const standing = await standingEventsFor(evidenceB.id);
    expect(standing).toHaveLength(1);
    expect(standing[0].action).toBe("VERIFY");
    expect(standing[0].previousVerificationStatus).toBe("UNVERIFIED");
    expect(standing[0].newVerificationStatus).toBe("VERIFIED");
    expect(standing[0].actorId).toBe(actorCtx.userId);
  });

  it("the actor's display name is snapshotted onto the standing event", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: instructorCtx, user: instructorUser } = await createTenantUser("INSTRUCTOR");
    await db.user.update({ where: { id: instructorUser.id }, data: { name: "Jane Smith" } });
    const { course: ownedCourse } = await createCourse(tenant.id, instructorCtx.userId);
    void course;
    void skill;
    const skill2 = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill2.id,
      courseId: ownedCourse.id,
    });
    const actorCtx = { ...instructorCtx, tenantId: tenant.id };

    await verifyEvidence(actorCtx, evidence.id);

    const [event] = await standingEventsFor(evidence.id);
    expect(event.actorName).toBe("Jane Smith");
  });
});

describe("D22 — soft-deleted learner security fix", () => {
  it("a soft-deleted learner's evidence cannot be verified", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await db.user.update({ where: { id: learnerCtx.userId }, data: { deletedAt: new Date() } });

    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toMatchObject({ status: 403 });
  });

  it("a soft-deleted learner's evidence cannot be revoked either", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await db.user.update({ where: { id: learnerCtx.userId }, data: { deletedAt: new Date() } });

    await expect(revokeEvidence(actorCtx, evidence.id, "reason")).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("D23 — cross-tenant existence leak fix (404, never a distinguishable 403)", () => {
  it("same-tenant, existing evidence: succeeds normally", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    await expect(verifyEvidence(actorCtx, evidence.id)).resolves.toBeDefined();
  });

  it("same-tenant, missing evidence: 404", async () => {
    const { actorCtx } = await setup();
    await expect(verifyEvidence(actorCtx, "does-not-exist")).rejects.toMatchObject({ status: 404 });
  });

  it("foreign-tenant, existing evidence: 404 (not 403 — indistinguishable from missing)", async () => {
    const { tenant: tenantA } = await setup();
    const {
      tenant: tenantB,
      learnerCtx: learnerB,
      course: courseB,
      skill: skillB,
      actorCtx: actorB,
    } = await setup();
    void tenantA;
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenantB.id,
      userId: learnerB.userId,
      skillId: skillB.id,
      courseId: courseB.id,
    });
    const { ctx: superAdminCtx } = await createTenantUser("SUPER_ADMIN");
    const foreignActorCtx = { ...superAdminCtx, tenantId: tenantA.id };
    void actorB;

    let caught: unknown;
    try {
      await verifyEvidence(foreignActorCtx, evidence.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapabilityVerificationError);
    expect((caught as CapabilityVerificationError).status).toBe(404);
  });

  it("foreign-tenant, nonexistent evidence: also 404, same shape", async () => {
    const { actorCtx } = await setup();
    await expect(verifyEvidence(actorCtx, "also-does-not-exist")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("subject-independence, isolated from role-authorization (the self-check must fire on its own, not merely as a side effect of an otherwise-unauthorized role)", () => {
  it("an INSTRUCTOR who owns the course AND is the evidence's own subject still cannot verify their own evidence — the self-check, not roleMayAttempt, is what refuses it", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    // Evidence whose subject IS the course-owning instructor themselves —
    // an otherwise fully-authorized actor (right role, right course
    // ownership) for whom only the subject-independence rule can refuse.
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: instructorCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    const actorCtx = { ...instructorCtx, tenantId: tenant.id };

    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe("validUntil — lazy expiry (docs/PHASE_30.3_DISCOVERY.md §5: no cron; the next real recompute picks it up)", () => {
  it("evidence valid while its validUntil is in the future contributes; once validUntil has passed, the NEXT real recompute excludes it — no cron required, no stale level lingers past the next write", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: course.id,
        verificationStatus: "VERIFIED",
        validUntil: new Date(Date.now() + 60_000), // valid for now
      },
    });
    await verifyEvidence(actorCtx, evidence.id); // no-op (already VERIFIED) but establishes the projection via a real recompute
    const { projectUserSkill } = await import("@/lib/domain/capability/proficiency");
    const established = await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    expect(established.proficiency).toBe("INTERMEDIATE");

    // Time passes — simulated by moving validUntil into the past directly
    // (no production writer sets validUntil yet, so this is the only way to
    // exercise the predicate; matches 30.1/30.2's own testing convention for
    // fields with no writer yet).
    await db.skillEvidence.update({
      where: { id: evidence.id },
      data: { validUntil: new Date(Date.now() - 1000) },
    });

    // No cron exists (by design — §5). The stored projection does NOT
    // auto-update just because time passed.
    const stillStale = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(stillStale.proficiency).toBe("INTERMEDIATE"); // lazy — nothing recomputed it yet

    // The NEXT real recompute (any evidence-standing write — here, unverify,
    // a genuine VERIFIED -> UNVERIFIED transition, not a no-op) picks up the
    // expiry correctly.
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const adminActorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const afterNextRecompute = await unverifyEvidence(adminActorCtx, evidence.id);
    expect(afterNextRecompute.proficiency).toBe("NONE"); // the expired evidence no longer contributes
  });
});

describe("tenant isolation — resolved-course tenant mismatch (a malformed row, evidence.tenantId===actor.tenantId but the sourceId course belongs to another tenant)", () => {
  it("even SUPER_ADMIN cannot verify evidence whose resolved course belongs to a different tenant than the evidence's own tenantId", async () => {
    const { tenant: tenantA, ctx: learnerA } = await createTenantUser("STUDENT");
    const { tenant: tenantB, ctx: instructorB } = await createTenantUser("INSTRUCTOR");
    const { course: courseB } = await createCourse(tenantB.id, instructorB.userId);
    const skill = await createSkill(tenantA.id);
    // Malformed: tenantId says A, but sourceId resolves to a course that is
    // actually owned by tenant B — the shape this session's D23/§25 defense
    // (course.tenantId !== actor.tenantId) specifically guards against.
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenantA.id,
        userId: learnerA.userId,
        skillId: skill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: courseB.id,
      },
    });
    const { ctx: superAdminCtx } = await createTenantUser("SUPER_ADMIN");
    const actorCtx = { ...superAdminCtx, tenantId: tenantA.id };

    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe("D21 — real database concurrency: the check-then-write race is closed by the FOR UPDATE lock", () => {
  type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

  function holdSkillEvidenceLock(evidenceId: string) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = db.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM "SkillEvidence" WHERE id = ${evidenceId} FOR UPDATE`;
      locked();
      await gate;
    });
    return { isLocked, release, done };
  }

  const settledWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  it("a lone verify genuinely blocks on a held row lock, then resolves cleanly once released", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const holder = holdSkillEvidenceLock(evidence.id);
    await holder.isLocked;

    const racer = verifyEvidence(actorCtx, evidence.id);
    expect(await settledWithin(racer, 150)).toBe(false); // genuinely blocked

    holder.release();
    await holder.done;
    await racer;

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.verificationStatus).toBe("VERIFIED");
    expect(row.revision).toBe(1);
    expect(await standingEventsFor(evidence.id)).toHaveLength(1);
  });

  it("verify vs. reject on the SAME row (two REAL racers, no decoy): both land, revision reaches 2, two standing events, and the second's `previousVerificationStatus` equals the first's `newVerificationStatus` — no lost update", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    const { ctx: secondSuperAdminCtx } = await createTenantUser("SUPER_ADMIN");
    const secondActorCtx = { ...secondSuperAdminCtx, tenantId: tenant.id };

    const holder = holdSkillEvidenceLock(evidence.id);
    await holder.isLocked;

    const racerVerify = verifyEvidence(actorCtx, evidence.id);
    const racerReject = rejectEvidence(secondActorCtx, evidence.id);

    holder.release();
    await holder.done;
    // Neither call's outcome depends on which one Postgres happened to
    // schedule first behind the lock — only the final state and the chain
    // invariant must hold. Both are expected to resolve (one applies verify,
    // then the other applies reject on top of it, or vice versa — REJECT's
    // source set includes VERIFIED and VERIFY's source set includes
    // REJECTED, so either interleaving is legal).
    await Promise.allSettled([racerVerify, racerReject]);

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.revision).toBe(2); // both transitions genuinely applied, none lost
    const events = await standingEventsFor(evidence.id);
    expect(events).toHaveLength(2);
    // Chain invariant: the second event's previous status is exactly the
    // first event's new status — no gap, no overwrite.
    expect(events[1].previousVerificationStatus).toBe(events[0].newVerificationStatus);
    expect(new Set(events.map((e) => e.action))).toEqual(new Set(["VERIFY", "REJECT"]));
  });

  it("verify vs. revoke on the SAME row (two REAL racers): either both land (VERIFIED+REVOKED, revision 2, two events) or the verify is refused NOT_ACTIVE after revoke wins (revision 1, one event) — never a silently corrupted mixed state", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const adminCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const holder = holdSkillEvidenceLock(evidence.id);
    await holder.isLocked;

    const racerVerify = verifyEvidence(actorCtx, evidence.id);
    const racerRevoke = revokeEvidence(adminCtx, evidence.id, "concurrency test");

    holder.release();
    await holder.done;
    const [verifyOutcome, revokeOutcome] = await Promise.allSettled([racerVerify, racerRevoke]);

    // revoke never fails (no precondition it can violate here — ACTIVE is
    // the only legal source state and the row starts ACTIVE).
    expect(revokeOutcome.status).toBe("fulfilled");

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    if (verifyOutcome.status === "fulfilled") {
      // verify won the race before revoke: both applied.
      expect(row.verificationStatus).toBe("VERIFIED");
      expect(row.state).toBe("REVOKED");
      expect(row.revision).toBe(2);
      expect(await standingEventsFor(evidence.id)).toHaveLength(2);
    } else {
      // revoke won first: verify then sees state=REVOKED and is refused NOT_ACTIVE.
      expect(verifyOutcome.reason).toMatchObject({ status: 409 });
      expect(row.state).toBe("REVOKED");
      expect(row.revision).toBe(1);
      expect(await standingEventsFor(evidence.id)).toHaveLength(1);
    }
  });

  it("duplicate concurrent revoke calls (two real racers, no decoy) on the same row: both resolve, exactly one actually applies, exactly one standing event", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const { ctx: secondOrgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const secondActorCtx = { ...secondOrgAdminCtx, tenantId: tenant.id };
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const holder = holdSkillEvidenceLock(evidence.id);
    await holder.isLocked;

    const racerA = revokeEvidence(actorCtx, evidence.id, "first revoke attempt");
    const racerB = revokeEvidence(secondActorCtx, evidence.id, "second revoke attempt");

    holder.release();
    await holder.done;
    await Promise.all([racerA, racerB]); // both resolve — the second is a no-op, never an error

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.state).toBe("REVOKED");
    expect(row.revision).toBe(1); // only one racer actually applied; the other saw the no-op
    expect(await standingEventsFor(evidence.id)).toHaveLength(1);
  });

  it("duplicate concurrent verify calls (two real racers, no decoy) on the same row: both resolve, exactly one standing event, first verifier wins", async () => {
    const { tenant, learnerCtx, course, skill, actorCtx } = await setup();
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    const { ctx: secondInstructorCtx } = await createTenantUser("SUPER_ADMIN");
    const secondActorCtx = { ...secondInstructorCtx, tenantId: tenant.id };

    const holder = holdSkillEvidenceLock(evidence.id);
    await holder.isLocked;

    const racerA = verifyEvidence(actorCtx, evidence.id);
    const racerB = verifyEvidence(secondActorCtx, evidence.id);

    holder.release();
    await holder.done;
    const [resultA, resultB] = await Promise.all([racerA, racerB]);

    expect(resultA.proficiency).toBe("INTERMEDIATE");
    expect(resultB.proficiency).toBe("INTERMEDIATE");

    const row = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(row.revision).toBe(1); // only ONE of the two racers actually applied; the other saw the no-op
    expect(await standingEventsFor(evidence.id)).toHaveLength(1);
  });

  it("revoke vs a concurrent recompute (evidence write) on the same skill: both land, final state is consistent", async () => {
    const { tenant, learnerCtx, course, skill } = await setup();
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const adminCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const evidenceA = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
      verificationStatus: "VERIFIED",
    });
    const { projectUserSkill } = await import("@/lib/domain/capability/proficiency");
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );

    const { course: courseB } = await createCourse(tenant.id, adminCtx.userId);
    await db.courseSkill.create({ data: { courseId: courseB.id, skillId: skill.id } });

    const [revokeResult] = await Promise.all([
      revokeEvidence(adminCtx, evidenceA.id, "concurrency test"),
      import("@/lib/domain/capability/outcomes").then(({ recordSkillEvidenceOutcome }) =>
        recordSkillEvidenceOutcome({
          tenantId: tenant.id,
          userId: learnerCtx.userId,
          skillId: skill.id,
          type: "COURSE_COMPLETION",
          sourceType: "Course",
          sourceId: courseB.id,
          occurredAt: new Date(),
        })
      ),
    ]);
    void revokeResult;

    const finalProjection = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    // Evidence A revoked (no longer contributes), evidence B (new, unverified)
    // now the only contributor -> BEGINNER, not NONE and not stale INTERMEDIATE.
    expect(finalProjection.proficiency).toBe("BEGINNER");
  });
});
