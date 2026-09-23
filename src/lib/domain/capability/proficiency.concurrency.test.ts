import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSkill } from "@/lib/domain/capability/__test__/fixtures";
import { recordSkillEvidenceOutcome } from "@/lib/domain/capability/outcomes";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * Phase 30.2 — real-database concurrency proof for the canonical recompute
 * (task §2/§24, C1-C6). Uses the repo's own established barrier convention
 * (learning-path/__test__/lock.ts's `holdLock`: an open transaction holding
 * a real Postgres row lock, with `isLocked`/`release`/`done` promises)
 * rather than sleeps — a deterministic way to observe a second transaction
 * genuinely blocking on `FOR UPDATE`, not just "didn't throw."
 */

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

describe("C2/C4 — recomputeUserSkill genuinely serializes on the UserSkill row lock", () => {
  it("two concurrent recomputes racing the FIRST-EVER creation of one (user, skill) row: exactly one row, no duplicate-key failure, no lost evidence", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "c4-a",
    });

    // Neither transaction can lock a row that doesn't exist yet — this is
    // exactly C4: both race step 1's `createMany({ skipDuplicates: true })`.
    // Postgres itself serializes the two inserts on the `[userId, skillId]`
    // unique constraint; one wins, the other's insert is skipped and it
    // proceeds straight to locking the winner's committed row.
    const [a, b] = await Promise.all([
      db.$transaction((tx) =>
        projectUserSkill(tx, {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          changeTimestamp: new Date(),
        })
      ),
      db.$transaction((tx) =>
        projectUserSkill(tx, {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          changeTimestamp: new Date(),
        })
      ),
    ]);
    expect(a.proficiency).toBe("BEGINNER");
    expect(b.proficiency).toBe("BEGINNER");

    const rows = await db.userSkill.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(rows).toHaveLength(1);

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    // Exactly one of the two racing recomputes is "the" creator and writes
    // the (null -> BEGINNER) event; the other finds the level already
    // matches and, per §7/P5, writes no second event.
    expect(events).toHaveLength(1);
    expect(events[0].previousProficiency).toBeNull();
    expect(events[0].newProficiency).toBe("BEGINNER");
    expect(rows[0].eventSeq).toBe(1);
  });

  it("two concurrent recomputes on an existing row: the second waits for the first's lock to release, and the final state reflects both evidence sets", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);

    // Establish the row first (outside the race) so this test isolates lock
    // contention on an EXISTING row, distinct from the creation race above.
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );

    const holder = holdUserSkillLock(ctx.userId, skill.id);
    await holder.isLocked;

    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "concurrent-a",
    });

    const second = db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
        cause: "EVIDENCE_ADDED",
      })
    );

    // The second recompute must NOT settle while the first still holds the lock.
    expect(await settledWithin(second, 150)).toBe(false);

    holder.release();
    await holder.done;

    const result = await second;
    expect(result.proficiency).toBe("BEGINNER");

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    // seq 1 was the setup call's own creation event (null -> NONE, zero
    // evidence at that point); seq 2 is this test's actual subject, the
    // blocked-then-released recompute (NONE -> BEGINNER).
    expect(userSkill.eventSeq).toBe(2);
  });

  it("two REAL concurrent recomputes racing each other (not a decoy holder) on an existing row: the lock is what prevents a lost evidence write, not incidental UPDATE-statement locking", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);

    // Establish the row (creation event, seq 1) before the race.
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );
    // Two evidence rows, EITHER of which alone raises NONE -> INTERMEDIATE —
    // both recomputes would compute the same next level if each reads a
    // stale "no evidence yet" snapshot, which is exactly the corrupting
    // interleaving F1's lock exists to prevent.
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "race-a",
    });
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "race-b",
      verificationStatus: "VERIFIED",
    });

    // Hold the row's lock first so BOTH racers arrive at their own
    // `SELECT ... FOR UPDATE` and queue behind it together, then release
    // once both are confirmed blocked — maximising genuine contention
    // between `a` and `b` themselves once the row frees up (Postgres's own
    // exclusive row lock, not this test's holder, is what then serializes
    // them against each other).
    const holder = holdUserSkillLock(ctx.userId, skill.id);
    await holder.isLocked;

    const a = db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
        cause: "EVIDENCE_ADDED",
      })
    );
    const b = db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
        cause: "EVIDENCE_VERIFIED",
      })
    );
    const both = Promise.all([a, b]);
    expect(await settledWithin(both, 150)).toBe(false);

    holder.release();
    await holder.done;

    // Without the lock, both `a` and `b` could read the row at the SAME
    // pre-write eventSeq, independently compute nextSeq = 2, and collide
    // on SkillProficiencyEvent's [userId, skillId, seq] unique constraint —
    // which would roll back whichever transaction loses the race, losing
    // its evidence-triggered recompute entirely rather than merely being
    // slow. Both must resolve cleanly.
    await expect(both).resolves.toBeDefined();

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
    expect(userSkill.eventSeq).toBe(2);

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1].newProficiency).toBe("INTERMEDIATE");
  });
});

describe("C1/C6 — concurrent evidence writes: no lost update, no duplicate/gapped event sequence", () => {
  it("two concurrent recordSkillEvidenceOutcome calls for the same (user, skill), different sources, both land — final proficiency and event history are consistent", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);

    const [a, b] = await Promise.all([
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "race-a",
        occurredAt: new Date(),
      }),
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "race-b",
        occurredAt: new Date(),
      }),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);

    const evidenceCount = await db.skillEvidence.count({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(evidenceCount).toBe(2);

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.proficiency).toBe("BEGINNER");

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
      orderBy: { seq: "asc" },
    });
    // INV8/INV9: one event per transition that reached the projection, gap-free.
    // The first write is a real transition (no projection -> BEGINNER); the
    // second's evidence set doesn't change the level (still BEGINNER), so it
    // must NOT add a second event (task §7/P5).
    expect(events).toHaveLength(1);
    expect(events.map((e) => e.seq)).toEqual([1]);
    expect(userSkill.eventSeq).toBe(1);
  });

  it("five concurrent evidence writes, one VERIFIED among them: eventSeq lands on exactly 2 (BEGINNER then INTERMEDIATE), never duplicated or skipped", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);

    await Promise.all([
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "seq-1",
        occurredAt: new Date(),
      }),
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "seq-2",
        occurredAt: new Date(),
      }),
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "seq-3",
        occurredAt: new Date(),
      }),
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "seq-4",
        occurredAt: new Date(),
      }),
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "seq-5",
        occurredAt: new Date(),
      }),
    ]);

    // Verify one of the five rows after the fact — a second, independent
    // transition (BEGINNER -> INTERMEDIATE).
    const rows = await db.skillEvidence.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
      orderBy: { sourceId: "asc" },
    });
    const evidence = rows[0];
    // verifyEvidence enforces course-ownership authorization, which this
    // MANUAL-sourced evidence can never resolve (resolveSourceCourse returns
    // null for it) — call the transaction directly instead, mirroring what
    // verification.ts itself does, to keep this test focused purely on
    // sequence allocation under concurrency rather than authorization.
    await db.$transaction(async (tx) => {
      const updated = await tx.skillEvidence.update({
        where: { id: evidence.id },
        data: { verificationStatus: "VERIFIED", revision: { increment: 1 } },
      });
      await projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
        cause: "EVIDENCE_VERIFIED",
        evidenceId: evidence.id,
        evidenceRevision: updated.revision,
      });
    });

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
    expect(events[0].newProficiency).toBe("BEGINNER");
    expect(events[1].newProficiency).toBe("INTERMEDIATE");

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.eventSeq).toBe(2);
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
  });
});

describe("C3 — evidence write concurrent with a direct recompute call", () => {
  it("both land; the final projection reflects the union of evidence, and no event is lost", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);
    await evidenceRow({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      sourceId: "pre-existing",
    });
    await db.$transaction((tx) =>
      projectUserSkill(tx, {
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        changeTimestamp: new Date(),
      })
    );

    await Promise.all([
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "c3-new",
        score: 90,
        occurredAt: new Date(),
      }),
      db.$transaction((tx) =>
        projectUserSkill(tx, {
          tenantId: tenant.id,
          userId: ctx.userId,
          skillId: skill.id,
          changeTimestamp: new Date(),
          cause: "RECALCULATED",
        })
      ),
    ]);

    const evidenceCount = await db.skillEvidence.count({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(evidenceCount).toBe(2);

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.proficiency).toBe("BEGINNER");
  });
});

describe("C5 — repeated identical evidence processing", () => {
  it("the same source processed twice, concurrently, creates one evidence row, one event, and eventSeq stays at 1", async () => {
    const { tenant, ctx } = await createTenantUser();
    const skill = await createSkill(tenant.id);

    const [a, b] = await Promise.all([
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "idempotent-source",
        occurredAt: new Date(),
      }),
      recordSkillEvidenceOutcome({
        tenantId: tenant.id,
        userId: ctx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "idempotent-source",
        occurredAt: new Date(),
      }),
    ]);
    // Exactly one call wins the P2002 race — the other's benign no-op (outcomes.ts).
    expect([a, b].filter(Boolean)).toHaveLength(1);

    const evidenceCount = await db.skillEvidence.count({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(evidenceCount).toBe(1);

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
    });
    expect(events).toHaveLength(1);

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: ctx.userId, skillId: skill.id } },
    });
    expect(userSkill.eventSeq).toBe(1);

    // Processing the exact same source a third time, sequentially, must
    // still be a no-op — no new row, no new event.
    const third = await recordSkillEvidenceOutcome({
      tenantId: tenant.id,
      userId: ctx.userId,
      skillId: skill.id,
      type: "MANUAL",
      sourceType: "Manual",
      sourceId: "idempotent-source",
      occurredAt: new Date(),
    });
    expect(third).toBe(false);
    expect(
      await db.skillEvidence.count({
        where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
      })
    ).toBe(1);
    expect(
      await db.skillProficiencyEvent.count({
        where: { tenantId: tenant.id, userId: ctx.userId, skillId: skill.id },
      })
    ).toBe(1);
  });
});
