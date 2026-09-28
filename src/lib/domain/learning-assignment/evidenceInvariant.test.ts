import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createScenario } from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

afterAll(async () => {
  await db.$disconnect();
});

/**
 * Phase 30.3 testing-contract gap (docs/PHASE_30.3_DISCOVERY.md §19/§31,
 * contract J1/INV17): "LearningAssignment state is never evidence" already
 * held (confirmed by grep — `learning-assignment` never calls
 * `db.skillEvidence.*`), and two existing tests already assert a zero
 * SkillEvidence count incidentally, for one scenario each (cancel;
 * duplicate-create). This is the general form: assign, cancel, and
 * reactivate (re-create after cancellation) in one sequence, asserting the
 * invariant holds at every step — not new behavior, closing a real,
 * previously-unnamed testing gap.
 */
describe("LearningAssignment never writes SkillEvidence — INV17, general form", () => {
  it("across assign -> cancel -> reactivate (re-assign), SkillEvidence count for the learner stays zero throughout", async () => {
    const { admin, learner, course } = await createScenario();

    const created = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });
    expect(created.ok).toBe(true);
    expect(await db.skillEvidence.count({ where: { userId: learner.user.id } })).toBe(0);

    if (!created.ok) throw new Error("setup failed");
    const cancelled = await cancelAssignment(admin.ctx, created.assignment.id);
    expect(cancelled.ok).toBe(true);
    expect(await db.skillEvidence.count({ where: { userId: learner.user.id } })).toBe(0);

    // Reactivate: re-create the same (learner, course) manual assignment
    // after cancellation — the one path this module treats as "assign
    // again," per its own sourceKey-idempotency design.
    const reactivated = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });
    expect(reactivated.ok).toBe(true);
    expect(await db.skillEvidence.count({ where: { userId: learner.user.id } })).toBe(0);
  });
});
