import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createCourse, createSkill } from "@/lib/domain/capability/__test__/fixtures";
import { backfillTenant } from "@/lib/domain/capability/capabilityBackfill";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

/** A UserSkill row exactly as it would look pre-Phase-30.2: eventSeq 0, no event ever written. */
async function preExistingUserSkill(params: {
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

async function evidenceRow(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  sourceId: string;
  verificationStatus?: "UNVERIFIED" | "VERIFIED" | "REJECTED";
  occurredAt?: Date | null;
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
      occurredAt: params.occurredAt ?? null,
    },
  });
}

/** Same real-lock barrier convention as proficiency.concurrency.test.ts / learning-path's lock.ts. */
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
function holdUserSkillLock(
  userId: string,
  skillId: string,
  whileLocked: (tx: Tx) => Promise<void> = async () => {}
) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "UserSkill" WHERE "userId" = ${userId} AND "skillId" = ${skillId} FOR UPDATE`;
    locked();
    await gate;
    await whileLocked(tx);
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

describe("backfillTenant — baseline event semantics (task §15)", () => {
  it("writes one BASELINE event whose newProficiency is the EXISTING stored value, previousProficiency null", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
      verificationStatus: "VERIFIED",
    });
    // Stored at INTERMEDIATE, matching what the evidence would compute to —
    // this is the reconciled-as-correct case backfill is meant for.
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "INTERMEDIATE",
    });

    const result = await backfillTenant(tenant.id);
    expect(result.rowsBaselined).toBe(1);

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].cause).toBe("BASELINE");
    expect(events[0].seq).toBe(1);
    expect(events[0].previousProficiency).toBeNull();
    expect(events[0].newProficiency).toBe("INTERMEDIATE");

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.eventSeq).toBe(1);
    expect(userSkill.policyVersion).toBe(1);
    // Never touches proficiency itself — even for an explained mismatch it
    // would still leave this alone (task §16: not backfill's job to correct it).
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
  });

  it("never writes proficiency, even for a row whose stored value is unreachable/explained (ADVANCED)", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "ADVANCED",
    });

    await backfillTenant(tenant.id);

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.proficiency).toBe("ADVANCED");
    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(events[0].newProficiency).toBe("ADVANCED");
  });
});

describe("backfillTenant — restartability and idempotency (task §23, P9)", () => {
  it("a second full run over the same tenant produces zero additional writes", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "s1",
    });
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });

    const first = await backfillTenant(tenant.id);
    expect(first.rowsBaselined).toBe(1);

    const second = await backfillTenant(tenant.id);
    expect(second.rowsConsidered).toBe(0);
    expect(second.rowsBaselined).toBe(0);

    const events = await db.skillProficiencyEvent.count({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(events).toBe(1);

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.eventSeq).toBe(1);
  });

  it("simulated interrupt-and-resume: a row already baselined by a prior partial run is skipped, an untouched row is picked up", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skillA.id,
      proficiency: "NONE",
    });
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skillB.id,
      proficiency: "NONE",
    });

    // Simulate "the run got as far as skillA before being killed" by
    // baselining only skillA directly, bypassing backfillTenant.
    await db.$transaction(async (tx) => {
      await tx.userSkill.update({
        where: { userId_skillId: { userId: ctx.userId, skillId: skillA.id } },
        data: { eventSeq: 1, policyVersion: 1 },
      });
      await tx.skillProficiencyEvent.create({
        data: {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skillA.id,
          seq: 1,
          cause: "BASELINE",
          previousProficiency: null,
          newProficiency: "NONE",
          policyVersion: 1,
          occurredAt: new Date(),
        },
      });
    });

    const resumed = await backfillTenant(tenant.id);
    expect(resumed.rowsConsidered).toBe(1); // only skillB was still eventSeq 0
    expect(resumed.rowsBaselined).toBe(1);

    const eventsA = await db.skillProficiencyEvent.count({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skillA.id },
    });
    const eventsB = await db.skillProficiencyEvent.count({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skillB.id },
    });
    expect(eventsA).toBe(1); // untouched by the resumed run
    expect(eventsB).toBe(1); // picked up by the resumed run
  });

  it("a row already advanced by live traffic (eventSeq > 0) before backfillTenant's batch query runs is excluded entirely, not double-baselined", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "NONE",
    });
    // A real, level-changing evidence write — unlike a no-op recompute, this
    // is what actually advances eventSeq past 0 (task §7/P5: a no-op writes
    // no event and leaves eventSeq untouched).
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "live-write",
    });
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
        cause: "EVIDENCE_ADDED",
      })
    );

    const result = await backfillTenant(tenant.id);
    expect(result.rowsConsidered).toBe(0);

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].cause).toBe("EVIDENCE_ADDED");
  });

  it("a row that flips to eventSeq > 0 WHILE backfillTenant's per-row lock is blocked (true concurrent race, not just a before/after ordering) is skipped, not double-baselined", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "NONE",
    });

    // Holds the row's real lock, and — once released — performs the exact
    // write a concurrent baseline/recompute would: advances eventSeq and
    // writes seq=1, all before backfillTenant's own blocked lock attempt
    // gets to run. This is what §13's "SELECT ... FOR UPDATE + re-check"
    // guards against — unlike the sequential test above, the row is still
    // eventSeq 0 when backfillTenant's OUTER batch query reads it in.
    const holder = holdUserSkillLock(ctx.userId, skill.id, async (tx) => {
      await tx.userSkill.update({
        where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
        data: { eventSeq: 1, policyVersion: 1 },
      });
      await tx.skillProficiencyEvent.create({
        data: {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          seq: 1,
          cause: "BASELINE",
          previousProficiency: null,
          newProficiency: "NONE",
          policyVersion: 1,
          occurredAt: new Date(),
        },
      });
    });
    await holder.isLocked;

    const backfillPromise = backfillTenant(tenant.id);
    // backfillTenant's outer findMany (unlocked) still sees eventSeq 0 and
    // includes the row — its per-row `SELECT ... FOR UPDATE` is what's
    // actually blocked on `holder`'s lock right now.
    expect(await settledWithin(backfillPromise, 150)).toBe(false);

    holder.release();
    await holder.done;
    const result = await backfillPromise;

    expect(result.rowsBaselined).toBe(0);
    expect(result.rowsAlreadyBaselined).toBe(1);
    expect(result.failures).toHaveLength(0);

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    // Exactly the holder's own event — backfillTenant's re-check must have
    // seen eventSeq=1 after acquiring the lock and backed off, not attempted
    // a second seq=1 insert (which the [userId,skillId,seq] unique
    // constraint would reject, surfacing as a failure rather than a clean skip).
    expect(events).toHaveLength(1);
  });
});

describe("backfillTenant — occurredAt/scorePercent fallback chain (contract §H7)", () => {
  it("a COURSE_COMPLETION-sourced row resolves occurredAt from Enrollment.completedAt", async () => {
    const { tenant, ctx } = await createTenantUser("STUDENT");
    const { ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);

    const completedAt = new Date("2026-01-15T00:00:00Z");
    await db.enrollment.create({
      data: { userId: ctx.userId, courseId: course.id, status: "COMPLETED", completedAt },
    });
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: course.id,
        verificationStatus: "UNVERIFIED",
      },
    });
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });

    const result = await backfillTenant(tenant.id);
    expect(result.evidenceOccurredAtFilled).toBe(1);

    const updated = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(updated.occurredAt?.getTime()).toBe(completedAt.getTime());
  });

  it("a row with no resolvable source falls back to its own createdAt, and the fallback is only ever applied once", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const evidence = await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "no-source-to-resolve",
    });
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });

    await backfillTenant(tenant.id);
    const filled = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(filled.occurredAt?.getTime()).toBe(evidence.createdAt.getTime());

    // A second run must not touch an already-set occurredAt (contract §B5 —
    // immutable once established) — the row's eventSeq is already 1, so the
    // second call's batch query excludes it entirely.
    const before = filled.occurredAt;
    await backfillTenant(tenant.id);
    const after = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(after.occurredAt?.getTime()).toBe(before?.getTime());
  });

  it("the occurredAt-null guard itself: a row still eligible for a second batch pass (eventSeq stuck at 0) never re-fills an already-set occurredAt", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    const evidence = await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "guard-check",
    });
    await preExistingUserSkill({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      proficiency: "BEGINNER",
    });
    // Pre-occupy seq=1 for this (user, skill) so backfillTenant's own
    // per-row BASELINE insert always collides and the row's eventSeq NEVER
    // advances past 0 — unlike the test above, this keeps the row eligible
    // for `fillMissingEvidenceMetadata` on a SECOND call, which is what
    // actually exercises the `occurredAt: null` guard rather than the outer
    // eventSeq batch filter.
    await db.skillProficiencyEvent.create({
      data: {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        seq: 1,
        cause: "BASELINE",
        previousProficiency: null,
        newProficiency: "BEGINNER",
        policyVersion: 1,
        occurredAt: new Date(),
      },
    });

    const first = await backfillTenant(tenant.id);
    expect(first.evidenceOccurredAtFilled).toBe(1);
    expect(first.failures).toHaveLength(1); // the seq=1 collision, expected

    const afterFirst = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(afterFirst.occurredAt).not.toBeNull();

    // Second call: the row is STILL eventSeq 0 (the per-row transaction
    // keeps failing on the same seq=1 collision), so it's included in the
    // batch again and fillMissingEvidenceMetadata runs on this evidence a
    // second time — the guard must leave the now-set occurredAt untouched.
    const second = await backfillTenant(tenant.id);
    expect(second.evidenceOccurredAtFilled).toBe(0);

    const afterSecond = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(afterSecond.occurredAt?.getTime()).toBe(afterFirst.occurredAt?.getTime());
  });
});

describe("backfillTenant — tenant isolation (task §21)", () => {
  it("processes only the given tenant's rows; another tenant's rows are untouched", async () => {
    const { tenant: tenantA, ctx: ctxA } = await createTenantUser();
    const { tenant: tenantB, ctx: ctxB } = await createTenantUser();
    const skillA = await createSkill(tenantA.id);
    const skillB = await createSkill(tenantB.id);
    await preExistingUserSkill({
      tenantId: tenantA.id,
      userId: ctxA.userId,
      skillId: skillA.id,
      proficiency: "NONE",
    });
    await preExistingUserSkill({
      tenantId: tenantB.id,
      userId: ctxB.userId,
      skillId: skillB.id,
      proficiency: "NONE",
    });

    const result = await backfillTenant(tenantA.id);
    expect(result.rowsConsidered).toBe(1);

    const bRow = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctxB.userId, skillId: skillB.id } },
    });
    expect(bRow.eventSeq).toBe(0);
  });
});

// `backfillAllTenants` is a thin per-tenant loop + arithmetic fold over
// `backfillTenant`, which the suite above already exercises exhaustively.
// It is NOT exercised here against the real database: this repo's
// accumulated test DB holds hundreds of thousands of users across many
// tenants, and `backfillAllTenants` has no tenant filter by design (task
// §14/§21 — it must cover every tenant) — a vitest test invoking it for
// real would iterate that entire accumulated dataset, which is minutes of
// work against a 5s test timeout, not a meaningful unit of test coverage.
// It was exercised for real, once, directly (not via vitest) to produce
// this phase's actual backfill numbers — see docs/PHASE_30.2_IMPLEMENTATION.md.
